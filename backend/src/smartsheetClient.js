// The only module in this project that talks to the Smartsheet API directly.
// Everything else (routes, frontend) goes through the functions exported here.

const BASE_URL = 'https://api.smartsheet.com/2.0';

function authHeaders() {
  const token = process.env.SMARTSHEET_API_TOKEN;
  if (!token) {
    throw new Error('SMARTSHEET_API_TOKEN is not set. Check backend/.env.');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function smartsheetRequest(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.message) || res.statusText;
    throw new Error(`Smartsheet API error (${res.status}): ${message}`);
  }
  return data;
}

async function getSheet(sheetId) {
  if (!sheetId) throw new Error('Missing sheet ID. Check backend/.env.');
  return smartsheetRequest(`/sheets/${sheetId}`);
}

// Column names -> column IDs are looked up per sheet and cached, since
// Smartsheet's API addresses cells by columnId, not by title.
const columnMapCache = new Map();

async function getColumnMap(sheetId, { forceRefresh = false } = {}) {
  if (!forceRefresh && columnMapCache.has(sheetId)) {
    return columnMapCache.get(sheetId);
  }
  const sheet = await getSheet(sheetId);
  const map = new Map(sheet.columns.map((col) => [col.title, col.id]));
  columnMapCache.set(sheetId, map);
  return map;
}

function buildCells(columnMap, fields) {
  const cells = [];
  for (const [title, value] of Object.entries(fields)) {
    const columnId = columnMap.get(title);
    if (!columnId) {
      throw new Error(
        `Column "${title}" not found on this sheet. Check that the sheet's ` +
          `column names match README.md exactly (case-sensitive).`
      );
    }
    cells.push({ columnId, value });
  }
  return cells;
}

function rowToObject(row, columnMap) {
  const idToTitle = new Map([...columnMap.entries()].map(([title, id]) => [id, title]));
  const obj = { rowId: row.id };
  for (const cell of row.cells) {
    const title = idToTitle.get(cell.columnId);
    // PUT responses for dropdown/picklist columns sometimes omit `value` and
    // only include `displayValue`, even though the write itself succeeded.
    if (title) obj[title] = cell.value ?? cell.displayValue ?? '';
  }
  return obj;
}

async function getRows(sheetId) {
  const sheet = await getSheet(sheetId);
  const columnMap = await getColumnMap(sheetId);
  return sheet.rows.map((row) => rowToObject(row, columnMap));
}

async function addRow(sheetId, fields) {
  const columnMap = await getColumnMap(sheetId);
  const cells = buildCells(columnMap, fields);
  const result = await smartsheetRequest(`/sheets/${sheetId}/rows`, {
    method: 'POST',
    body: JSON.stringify({ toBottom: true, cells }),
  });
  return rowToObject(result.result, columnMap);
}

async function updateRow(sheetId, rowId, fields) {
  const columnMap = await getColumnMap(sheetId);
  const cells = buildCells(columnMap, fields);
  const result = await smartsheetRequest(`/sheets/${sheetId}/rows`, {
    method: 'PUT',
    body: JSON.stringify([{ id: rowId, cells }]),
  });
  return rowToObject(result.result[0], columnMap);
}

async function addRows(sheetId, fieldsArray) {
  if (!fieldsArray || fieldsArray.length === 0) return [];
  const columnMap = await getColumnMap(sheetId);
  const rows = fieldsArray.map((fields) => ({ toBottom: true, cells: buildCells(columnMap, fields) }));
  const result = await smartsheetRequest(`/sheets/${sheetId}/rows`, {
    method: 'POST',
    body: JSON.stringify(rows),
  });
  return result.result.map((row) => rowToObject(row, columnMap));
}

async function deleteRows(sheetId, rowIds) {
  if (!rowIds || rowIds.length === 0) return { result: [] };
  return smartsheetRequest(
    `/sheets/${sheetId}/rows?ids=${rowIds.join(',')}&ignoreRowsNotFound=true`,
    { method: 'DELETE' }
  );
}

module.exports = { getSheet, getColumnMap, getRows, addRow, addRows, updateRow, deleteRows };
