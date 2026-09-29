// Pure version state. The legacy fields are a read-only projection of selection.
// Persisted node properties may be Vue proxies; JSON is also their workflow format.
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const fileKey = file => file?.filename ? JSON.stringify([file.type || 'output', file.subfolder || '', file.filename]) : '';
const ordered = item => [...(item?.versions || [])].sort((a, b) => a.number - b.number);

export function currentVersion(item) {
  const versions = ordered(item);
  return versions.find(version => version.id === item?.selectedVersionId) || versions.at(-1) || null;
}
export function previousVersion(item) {
  const versions = ordered(item), current = currentVersion(item);
  return versions[versions.findIndex(version => version.id === current?.id) - 1] || null;
}
export function projectItem(item) {
  const current = currentVersion(item);
  return { ...item, selectedVersionId: current?.id || null,
    original: current ? clone(current.file) : null, upscaled: null, upscaleHistory: [],
    snapshot: current ? clone(current.snapshot || {}) : {}, selectedVersion: 'original' };
}

export function migrateHistory(history = []) {
  return (Array.isArray(history) ? history : []).map(entry => {
    const item = clone(entry);
    if (!Array.isArray(item.versions)) {
      const selectedKey = fileKey(item[item.selectedVersion === 'upscaled' ? 'upscaled' : 'original']);
      const seen = new Set();
      item.versions = [item.original, ...(item.upscaleHistory || []), item.upscaled].filter(file => {
        const key = fileKey(file);
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
      }).map((file, index) => ({
        id: index === 0 && fileKey(file) === fileKey(item.original) ? `${item.id}:original` : `${item.id}:file:${fileKey(file)}`,
        number: index + 1, file: clone(file),
        snapshot: { ...clone(item.snapshot || {}), ...(index > 0 ? { rtx_scale:file.scale ?? null, rtx_quality:file.quality ?? null } : {}) },
        operation: index === 0 && fileKey(file) === fileKey(item.original) ? 'generate' : 'upscale',
        sourceVersionId: index ? `${item.id}:original` : null,
        createdAt: index === 0 ? item.createdAt ?? null : file.createdAt ?? null,
      }));
      item.selectedVersionId = item.versions.find(version => fileKey(version.file) === selectedKey)?.id || item.versions.at(-1)?.id;
    }
    item.versions = ordered(item);
    if (item.archived === undefined) item.archived = false;
    if (item.archiveGroup === undefined) item.archiveGroup = null;
    const high = Math.max(0, ...item.versions.map(version => Number(version.number) || 0));
    item.nextVersionNumber = Math.max(high + 1, Number(item.nextVersionNumber) || 1);
    return projectItem(item);
  });
}

export function selectVersion(history, resultId, versionId) {
  return migrateHistory(history).map(item => item.id === resultId && item.versions.some(version => version.id === versionId)
    ? projectItem({ ...item, selectedVersionId: versionId }) : item);
}

export function appendVersion(history, resultId, { file, snapshot = {}, operation = 'regenerate', sourceVersionId = null, id, createdAt = Date.now() } = {}) {
  const migrated = migrateHistory(history);
  if (!fileKey(file)) return migrated;
  return migrated.map(item => {
    if (item.id !== resultId) return item;
    const versionId = id || `${resultId}:file:${fileKey(file)}`;
    if (item.versions.some(version => version.id === versionId || fileKey(version.file) === fileKey(file))) return item;
    const version = { id: versionId, number: item.nextVersionNumber, file: clone(file), snapshot: clone(snapshot), operation, sourceVersionId, createdAt };
    return projectItem({ ...item, versions: [...item.versions, version], selectedVersionId: version.id, nextVersionNumber: version.number + 1 });
  });
}

export function addGeneratedResult(history, result, context = {}) {
  const migrated = migrateHistory(history);
  if (!result?.id || result.error || !fileKey(result.original)) return migrated;
  if (context.operation && context.operation !== 'generate') {
    // A missing target must never turn an edit into a different work's version.
    return appendVersion(migrated, context.targetResultId, { id: result.id, file: result.original,
      snapshot: result.snapshot || {}, operation: context.operation, sourceVersionId: context.sourceVersionId || null,
      createdAt: result.createdAt ?? Date.now() });
  }
  if (migrated.some(item => item.id === result.id || item.versions.some(version => version.id === result.id))) return migrated;
  const version = { id: result.id, number: 1, file: clone(result.original), snapshot: clone(result.snapshot || {}),
    operation: 'generate', sourceVersionId: null, createdAt: result.createdAt ?? Date.now() };
  return [...migrated, projectItem({ ...clone(result), versions: [version], selectedVersionId: version.id, nextVersionNumber: 2 })];
}

export function versionFiles(item) {
  const migrated = migrateHistory([item])[0], seen = new Set();
  return migrated.versions.map(version => version.file).filter(file => {
    const key = fileKey(file);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(clone);
}


function dateParts(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}_${String(date.getMonth() + 1).padStart(2, '0')}_${String(date.getDate()).padStart(2, '0')}`;
}
function dateFromFilename(file) {
  const match = String(file?.filename || '').match(/(?:^|\D)(\d{4})[_-](\d{2})[_-](\d{2})(?:\D|$)/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)
    ? `${year}_${month}_${day}` : null;
}
function metadataFor(metadataByFile, file) {
  const key = fileKey(file);
  if (metadataByFile instanceof Map) return metadataByFile.get(key) || metadataByFile.get(file?.filename) || null;
  return metadataByFile?.[key] || metadataByFile?.[file?.filename] || null;
}
function itemFiles(item) {
  if (Array.isArray(item?.versions)) return item.versions.map(version => version?.file).filter(Boolean);
  return [item?.original, ...(item?.upscaleHistory || []), item?.upscaled].filter(Boolean);
}
function itemDate(item, metadataByFile) {
  const files = itemFiles(item);
  for (const file of files) {
    const date = dateFromFilename(file);
    if (date) return date;
  }
  const timestampValues = [item?.createdAt, ...(item?.versions || []).map(version => version?.createdAt)]
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => ({ value, timestamp: new Date(value).getTime() }))
    .filter(entry => Number.isFinite(entry.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (timestampValues.length) return dateParts(timestampValues[0].value);
  for (const file of files) {
    const date = dateParts(metadataFor(metadataByFile, file)?.mtime);
    if (date) return date;
  }
  return null;
}
function groupedResult(groups, ungroupedIds) {
  return { groups: [...groups.values()].map(group => ({ ...group, resultIds:[...group.resultIds], ...(group.subfolders ? { subfolders:[...group.subfolders] } : {}) })), ungroupedResultIds:ungroupedIds };
}

export function setArchived(history = [], resultIds = [], { archived, group, archivedAt } = {}) {
  const selected = new Set(Array.isArray(resultIds) ? resultIds : [resultIds]);
  return migrateHistory(history).map(item => selected.has(item.id)
    ? { ...item, archived: Boolean(archived), archivedAt: archived ? (archivedAt ?? Date.now()) : null, archiveGroup: archived ? (group ?? item.archiveGroup ?? null) : null }
    : item);
}

function localDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function isAvailableReference(item, now = Date.now()) {
  if (!item?.archived) return true;
  if (item.archivedAt === null || item.archivedAt === undefined || item.archivedAt === '') return false;
  const archivedDate = localDateKey(item.archivedAt);
  return Boolean(archivedDate && archivedDate === localDateKey(now));
}

export function organizeByDate(history = [], metadataByFile = {}) {
  const groups = new Map(), ungroupedIds = [];
  for (const item of migrateHistory(history)) {
    const date = itemDate(item, metadataByFile);
    if (!date) { ungroupedIds.push(item.id); continue; }
    if (!groups.has(date)) groups.set(date, { key:date, label:date, resultIds:[] });
    groups.get(date).resultIds.push(item.id);
  }
  return groupedResult(new Map([...groups].sort(([a], [b]) => a.localeCompare(b))), ungroupedIds);
}

export function groupFoldersByMonth(history = [], metadataByFile = new Map()) {
  const folders = new Map(), ungroupedResultIds = [], groups = new Map();
  for (const item of migrateHistory(history)) {
    const versions = [...(item.versions || [])].sort((a, b) => a.number - b.number);
    const generated = versions.filter(version => version.operation === 'generate');
    const folderVersion = generated.find(version => version.file?.subfolder)
      || versions.find(version => version.file?.subfolder);
    const recordFile = item.original || itemFiles(item)[0] || null;
    const folderFile = folderVersion?.file || recordFile;
    const subfolder = folderFile?.subfolder;
    if (!subfolder) { ungroupedResultIds.push(item.id); continue; }
    if (!folders.has(subfolder)) folders.set(subfolder, { subfolder, records:new Set(), candidates:[] });
    const folder = folders.get(subfolder);
    folder.records.add(item.id);
    folder.candidates.push(itemDate(item, metadataByFile));
  }
  for (const folder of folders.values()) {
    const match = String(folder.subfolder).match(/(?:^|\D)(\d{4})[_-](\d{2})(?:[_-]\d{2})?(?:\D|$)/);
    const directoryMonth = match && Number(match[2]) >= 1 && Number(match[2]) <= 12
      ? `${match[1]}_${match[2]}` : null;
    const month = directoryMonth || folder.candidates.filter(Boolean).sort()[0]?.slice(0, 7);
    if (!month) { ungroupedResultIds.push(...folder.records); continue; }
    if (!groups.has(month)) groups.set(month, { key:month, label:month, resultIds:[], subfolders:[] });
    const group = groups.get(month);
    group.subfolders.push(folder.subfolder);
    for (const id of folder.records) group.resultIds.push(id);
  }
  return groupedResult(new Map([...groups].sort(([a], [b]) => a.localeCompare(b))), ungroupedResultIds);
}
export function otherVersionCount(item) {
  const versions = Array.isArray(item?.versions) ? item.versions : [];
  return Math.max(0, versions.length - (currentVersion(item) ? 1 : 0));
}
export function addPromptSnapshot(history = [], { prompt = '', refs = [], region = null, id, createdAt = Date.now() } = {}, limit = 50) {
  const next = clone(Array.isArray(history) ? history : []);
  if (!String(prompt).trim()) return next;
  const content = { prompt: String(prompt), refs: clone(refs), ...(region?{region:clone(region)}:{}) };
  const previous = next.at(-1);
  if (previous?.prompt === content.prompt && JSON.stringify(previous.refs || []) === JSON.stringify(content.refs) && JSON.stringify(previous.region || null)===JSON.stringify(region)) return next;
  next.push({ ...content, id: id || globalThis.crypto.randomUUID(), createdAt });
  return next.slice(-Math.max(1, Math.min(50, Math.floor(limit) || 50)));
}
