/* eslint-disable no-console */
// Reordena TODAS las colecciones por:
// 1) cobertura total de variantes con stock (2 = todas, 1 = parcial, 0 = sin stock)
// 2) desempate por inventario total (desc)
// 3) desempate por # de variantes con stock (desc)
// 4) desempate estable por título (asc)

const fetchImpl =
  typeof fetch === "function" ? fetch : ((...a) => import("node-fetch").then(({ default: f }) => f(...a)));

const STORE = process.env.SHOPIFY_STORE_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-01";

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const INCLUDE_SMART = (process.env.INCLUDE_SMART || "true").toLowerCase() === "true";
const INCLUDE_MANUAL = (process.env.INCLUDE_MANUAL || "true").toLowerCase() === "true";
const HANDLE_PREFIX = (process.env.HANDLE_PREFIX || "").trim();

const MAX_PRODUCTS_PER_PAGE = Number(process.env.MAX_PRODUCTS_PER_PAGE || "25");
const MAX_INVENTORY_LEVELS = Number(process.env.MAX_INVENTORY_LEVELS || "10");
const LOCATION_IDS = (process.env.LOCATION_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!STORE || !TOKEN) {
  console.error("Faltan envs: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN");
  process.exit(1);
}

const GQL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
  const res = await fetchImpl(GQL, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GraphQL HTTP ${res.status}: ${t}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

const LIST_COLLECTIONS = `
query ListCollections($cursor: String) {
  collections(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      handle
      sortOrder
      ruleSet { rules { column relation condition } } # si existe => smart
    }
  }
}`;

const COLLECTION_PRODUCTS = `
query CollectionProducts($id: ID!, $cursor: String, $perPage: Int!, $invLevels: Int!) {
  collection(id: $id) {
    id
    products(first: $perPage, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        variants(first: 100) {
          nodes {
            id
            inventoryItem {
              inventoryLevels(first: $invLevels) {
                nodes {
                  location { id }
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const COLLECTION_UPDATE_SORT = `
mutation UpdateCollectionSort($id: ID!) {
  collectionUpdate(input: { id: $id, sortOrder: MANUAL }) {
    collection { id sortOrder }
    userErrors { field message }
  }
}`;

const COLLECTION_REORDER = `
mutation ReorderProducts($collectionId: ID!, $moves: [MoveInput!]!) {
  collectionReorderProducts(id: $collectionId, moves: $moves) {
    job { id }
    userErrors { field message }
  }
}`;

const JOB_QUERY = `
query Job($id: ID!) {
  job(id: $id) { id done }
}`;

function isSmart(col) {
  return !!col.ruleSet;
}

async function fetchAllCollections() {
  const out = [];
  let cursor = null;
  while (true) {
    const data = await gql(LIST_COLLECTIONS, { cursor });
    out.push(...data.collections.nodes);
    const { hasNextPage, endCursor } = data.collections.pageInfo;
    if (!hasNextPage) break;
    cursor = endCursor;
  }
  return out.filter(c => {
    if (HANDLE_PREFIX && !c.handle.startsWith(HANDLE_PREFIX)) return false;
    if (!INCLUDE_SMART && isSmart(c)) return false;
    if (!INCLUDE_MANUAL && !isSmart(c)) return false;
    return true;
  });
}

async function fetchAllProductsInCollection(collectionId) {
  const products = [];
  let cursor = null;
  while (true) {
    const data = await gql(COLLECTION_PRODUCTS, {
      id: collectionId,
      cursor,
      perPage: MAX_PRODUCTS_PER_PAGE,
      invLevels: MAX_INVENTORY_LEVELS,
    });
    const col = data.collection;
    if (!col) break;
    products.push(...col.products.nodes);
    const { hasNextPage, endCursor } = col.products.pageInfo;
    if (!hasNextPage) break;
    cursor = endCursor;
  }
  return products;
}

function sumAvailable(levels) {
  // levels.nodes[*].quantities contiene [{ name: "available", quantity }]
  return (levels?.nodes || []).reduce((sum, lvl) => {
    if (LOCATION_IDS.length && (!lvl.location || !LOCATION_IDS.includes(lvl.location.id))) return sum;
    const q = (lvl.quantities || []).find(q => q.name === "available");
    return sum + (q?.quantity || 0);
  }, 0);
}

function scoreProducts(products) {
  return products.map(p => {
    const vars = (p.variants?.nodes || []);
    const totalVariants = vars.length || 0;
    let variantsWithStock = 0;
    let totalInventory = 0;

    for (const v of vars) {
      const avail = sumAvailable(v.inventoryItem?.inventoryLevels);
      totalInventory += avail;
      if (avail > 0) variantsWithStock += 1;
    }

    // 2 = todas las variantes con stock; 1 = parcial; 0 = sin stock
    const coverageScore = variantsWithStock === 0 ? 0 :
                          (variantsWithStock === totalVariants ? 2 : 1);

    return {
      id: p.id,
      title: p.title,
      coverageScore,
      totalInventory,
      variantsWithStock,
      totalVariants,
    };
  });
}

function sortByScore(arr) {
  return [...arr].sort((a, b) => {
    if (b.coverageScore !== a.coverageScore) return b.coverageScore - a.coverageScore;
    if (b.totalInventory !== a.totalInventory) return b.totalInventory - a.totalInventory;
    if (b.variantsWithStock !== a.variantsWithStock) return b.variantsWithStock - a.variantsWithStock;
    return a.title.localeCompare(b.title);
  });
}

async function setManualSortIfNeeded(collection) {
  if (collection.sortOrder === "MANUAL") return;
  const data = await gql(COLLECTION_UPDATE_SORT, { id: collection.id });
  const errs = data.collectionUpdate?.userErrors || [];
  if (errs.length) throw new Error(`collectionUpdate errores: ${JSON.stringify(errs)}`);
}

async function applyReorder(collectionId, currentIds, newIds) {
  // Genera movimientos mínimos: solo los que cambian de posición
  const moves = [];
  const currIndex = new Map();
  currentIds.forEach((id, i) => currIndex.set(id, i));

  newIds.forEach((id, newPos) => {
    const prev = currIndex.get(id);
    if (prev === undefined) return; // producto nuevo por reglas
    if (prev !== newPos) moves.push({ id, newPosition: String(newPos) }); // UnsignedInt64 como string
  });

  if (!moves.length) {
    console.log("Orden ya óptimo, sin cambios.");
    return;
  }

  // Enviar en lotes por seguridad
  const chunk = 200;
  for (let i = 0; i < moves.length; i += chunk) {
    const slice = moves.slice(i, i + chunk);
    const data = await gql(COLLECTION_REORDER, { collectionId, moves: slice });
    const errs = data.collectionReorderProducts?.userErrors || [];
    if (errs.length) throw new Error(`collectionReorderProducts errores: ${JSON.stringify(errs)}`);

    const jobId = data.collectionReorderProducts?.job?.id;
    if (jobId) {
      // Polling simple: esperamos a que done = true
      for (let k = 0; k < 30; k++) {
        await sleep(500);
        const j = await gql(JOB_QUERY, { id: jobId });
        if (j.job?.done) break;
      }
    }
  }
}

async function main() {
  console.log("→ Leyendo colecciones…");
  const cols = await fetchAllCollections();
  console.log(`Colecciones a procesar: ${cols.length}`);

  for (const col of cols) {
    const type = isSmart(col) ? "SMART" : "MANUAL";
    console.log(`\n→ [${type}] ${col.title} (${col.handle}) | ${col.id}`);

    const prods = await fetchAllProductsInCollection(col.id);
    const currentIds = prods.map(p => p.id);

    const scored = scoreProducts(prods);
    const sorted = sortByScore(scored);
    const newIds = sorted.map(x => x.id);

    // Vista previa Top 10
    console.table(sorted.slice(0, 10).map((p, i) => ({
      rank: i + 1,
      title: p.title,
      coverage: p.coverageScore,
      totalInv: p.totalInventory,
      withStock: `${p.variantsWithStock}/${p.totalVariants}`,
    })));

    if (DRY_RUN) {
      console.log("DRY_RUN=TRUE → No se aplican cambios.");
      continue;
    }

    await setManualSortIfNeeded(col);
    await applyReorder(col.id, currentIds, newIds);

    // Pausa leve por rate limits
    await sleep(300);
    console.log("✔ Reordenado.");
  }

  console.log("\n✔ Listo. Todas las colecciones procesadas.");
}

main().catch(e => {
  console.error("ERROR:", e);
  process.exit(1);
});
