import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateHistory, currentVersion, previousVersion, selectVersion, appendVersion, addGeneratedResult, addPromptSnapshot, versionFiles, projectItem, fileKey, setArchived, isAvailableReference, organizeByDate, groupFoldersByMonth, otherVersionCount } from '../web/version-state.mjs';
const file = name => ({ filename:`${name}.png`,subfolder:'qwen_auto',type:'output' });
const legacy = () => ({id:'work',title:'作品',createdAt:123,original:file('one'),upscaleHistory:[file('two')],upscaled:file('three'),selectedVersion:'upscaled',snapshot:{steps:24,refs:[]}});
test('workflow proxy properties migrate and snapshot without DataCloneError',()=>{
  const proxy=new Proxy(legacy(),{});
  const migrated=migrateHistory([proxy]);assert.equal(migrated[0].versions.length,3);
  const snapshots=addPromptSnapshot([],new Proxy({prompt:'hello',refs:[new Proxy({id:'x',name:'one.png'}, {})]},{}));
  assert.equal(snapshots[0].refs[0].name,'one.png');
});
test('legacy migration preserves ordered files, selection and is idempotent', () => {
  const old = legacy(); old.upscaleHistory.push(file('three'));
  const migrated = migrateHistory([old]);
  assert.deepEqual(migrated[0].versions.map(v=>v.file.filename),['one.png','two.png','three.png']);
  assert.equal(currentVersion(migrated[0]).number,3);
  assert.equal(migrated[0].snapshot.steps,24);
  assert.deepEqual(migrateHistory(migrated),migrated);
  assert.equal(old.original.filename,'one.png');
  assert.equal(migrated[0].versions[1].createdAt,null);
});
test('rollback appends at high water mark; pruning retains numbering and previous surviving comparison', () => {
  let history = migrateHistory([legacy()]);
  history = selectVersion(history,'work',history[0].versions[1].id);
  history = appendVersion(history,'work',{file:file('four'),operation:'edit',sourceVersionId:history[0].selectedVersionId,snapshot:{steps:40}});
  assert.equal(currentVersion(history[0]).number,4);
  assert.equal(previousVersion(history[0]).number,3);
  history[0] = projectItem({...history[0],versions:history[0].versions.filter(v=>v.number===2),selectedVersionId:history[0].versions[1].id});
  history=appendVersion(history,'work',{file:file('five')});
  assert.equal(currentVersion(history[0]).number,5);
  assert.equal(previousVersion(history[0]).number,2);
});
test('duplicate completion is idempotent and target fencing never changes another work', () => {
  const initial = addGeneratedResult([],{id:'work',original:file('one'),snapshot:{steps:24}});
  const result = {id:'result-two',original:file('two'),snapshot:{steps:30}};
  const context = {operation:'regenerate',targetResultId:'work',sourceVersionId:'work'};
  const next=addGeneratedResult(initial,result,context);
  assert.equal(next[0].versions.length,2);
  assert.deepEqual(addGeneratedResult(next,result,context),next);
  assert.deepEqual(addGeneratedResult(next,result,{...context,targetResultId:'missing'}),next);
  assert.equal(initial[0].versions.length,1);
  assert.equal(currentVersion(next[0]).snapshot.steps,30);
  assert.deepEqual(addGeneratedResult(next,{...result,error:'failed'},context),next);
});
test('selection changes projection without mutating prior version data', () => {
  const history=migrateHistory([legacy()]);
  const next=selectVersion(history,'work',history[0].versions[0].id);
  assert.equal(next[0].original.filename,'one.png');
  assert.equal(history[0].original.filename,'three.png');
  assert.equal(previousVersion(next[0]),null);
  assert.equal(versionFiles(next[0]).length,3);
  assert.deepEqual(selectVersion(next,'work','missing'),next);
});
test('prompt snapshots cap at 50, detach refs and deduplicate content plus references', () => {
  let history=[];
  for(let i=0;i<51;i++) history=addPromptSnapshot(history,{prompt:`text ${i}`,id:`p${i}`,refs:[]});
  assert.equal(history.length,50); assert.equal(history[0].id,'p1');
  const refs=[{id:'r',name:'file',versionId:'v1'}];
  history=addPromptSnapshot(history,{prompt:'text 50',refs,id:'changed-ref'});
  assert.equal(history.at(-1).id,'changed-ref');
  assert.deepEqual(addPromptSnapshot(history,{prompt:'text 50',refs}),history);
  refs[0].versionId='v2';
  assert.equal(history.at(-1).refs[0].versionId,'v1');
  assert.deepEqual(addPromptSnapshot(history,{prompt:'  ',refs}),history);
});

test('archive state defaults legacy records to unarchived and updates selected ids immutably', () => {
  const history = [{ id:'a', original:file('a') }, { id:'b', archived:true, archiveGroup:'2026_01_02' }];
  const archived = setArchived(history, ['a'], { archived:true, group:'2026_09_29' });
  assert.equal(archived[0].archived, true);
  assert.equal(archived[0].archiveGroup, '2026_09_29');
  assert.equal(archived[1].archiveGroup, '2026_01_02');
  const restored = setArchived(archived, ['a'], { archived:false });
  assert.equal(restored[0].archived, false);
  assert.equal(restored[0].archiveGroup, null);
  assert.equal(restored[1].archiveGroup, '2026_01_02');
  assert.equal(history[0].archived, undefined);
});

test('archive visibility uses local operation date and never invents legacy timestamps', () => {
  const now = new Date(2026, 8, 29, 12).getTime();
  const archived = setArchived([{id:'new'},{id:'old',archived:true}], ['new'], {archived:true,group:'today',archivedAt:now});
  assert.equal(archived[0].archivedAt,now);
  assert.equal(isAvailableReference(archived[0],now),true);
  assert.equal(isAvailableReference(archived[0],new Date(2026,8,30,0,1).getTime()),false);
  assert.equal(isAvailableReference(archived[1],now),false);
  const restored=setArchived(archived,['new'],{archived:false});
  assert.equal(restored[0].archivedAt,null);
  assert.equal(isAvailableReference(restored[0],now),true);
});

test('date organization prefers filename date, falls back to work or earliest version date, then metadata', () => {
  const history = [
    { id:'filename', createdAt:'2020-01-01', original:file('image_2026_09_28') },
    { id:'created', createdAt:'2026-09-27T00:00:00Z', original:file('no-date') },
    { id:'version', createdAt:'2026-09-29T00:00:00Z', versions:[{id:'v1',number:1,file:file('v1'),createdAt:'2026-09-27T00:00:00Z'},{id:'v2',number:2,file:file('v2'),createdAt:'2026-09-26T00:00:00Z'}], selectedVersionId:'v1' },
    { id:'mtime', original:file('unknown') },
    { id:'unknown', original:file('nothing') },
  ];
  const metadata = new Map([[fileKey(file('unknown')), {mtime:Date.parse('2026-09-25T12:00:00Z')}]]);
  const result = organizeByDate(history, metadata);
  assert.deepEqual(result.groups.map(group => [group.key, group.label, group.resultIds]), [
    ['2026_09_25','2026_09_25',['mtime']], ['2026_09_26','2026_09_26',['version']], ['2026_09_27','2026_09_27',['created']], ['2026_09_28','2026_09_28',['filename']],
  ]);
  assert.deepEqual(result.ungroupedResultIds, ['unknown']);
});

test('date organization is repeatable and returns groups usable as archiveGroup values', () => {
  const history = [{ id:'a', original:file('render_2026-03-04.png') }];
  const first = organizeByDate(history, {});
  const second = organizeByDate(history, {});
  assert.deepEqual(second, first);
  const updated = setArchived(history, first.groups[0].resultIds, { archived:true, group:first.groups[0].key });
  assert.deepEqual(organizeByDate(updated, {}), first);
  assert.equal(history[0].archived, undefined);
});

test('physical subfolders group by month using directory name then known item dates', () => {
  const history = [
    { id:'named', original:{...file('one'),subfolder:'2025_12_batch'} },
    { id:'dated', createdAt:'2026-02-11T00:00:00Z', original:{...file('two'),subfolder:'batch-a'} },
    { id:'mtime', original:{...file('three'),subfolder:'batch-b'} },
    { id:'unknown', original:{...file('four'),subfolder:'batch-c'} },
    { id:'same', original:{...file('five'),subfolder:'batch-a'} },
  ];
  const result = groupFoldersByMonth(history, new Map([[fileKey({...file('three'),subfolder:'batch-b'}), {mtime:Date.parse('2026-02-01T00:00:00Z')}]]));
  assert.deepEqual(result.groups.map(group => [group.key, group.label, group.resultIds, group.subfolders]), [
    ['2025_12','2025_12',['named'],['2025_12_batch']], ['2026_02','2026_02',['dated','same','mtime'],['batch-a','batch-b']],
  ]);
  assert.deepEqual(result.ungroupedResultIds, ['unknown']);
});

test('other version count excludes the selected existing version', () => {
  const item = { versions:[{id:'v1',number:1},{id:'v2',number:2},{id:'v3',number:3}], selectedVersionId:'v2' };
  assert.equal(otherVersionCount(item), 2);
  assert.equal(otherVersionCount({versions:[],selectedVersionId:null}), 0);
});
test('month grouping assigns each work once using its earliest generated version and validates directory months', () => {
  const history = [
    {id:'cross',versions:[
      {id:'v1',number:1,operation:'generate',file:{...file('render_2026_01_08'),subfolder:'2026_01'},createdAt:'2026-01-08T00:00:00Z'},
      {id:'v2',number:2,operation:'edit',file:{...file('render_2026_02_09'),subfolder:'2026_02'},createdAt:'2026-02-09T00:00:00Z'},
    ],selectedVersionId:'v2'},
    {id:'invalid',versions:[{id:'bad',number:1,operation:'generate',file:{...file('render_2026_05_07'),subfolder:'2026_13'},createdAt:'2026-05-07T00:00:00Z'}],selectedVersionId:'bad'},
    {id:'unknown',versions:[{id:'u',number:1,operation:'generate',file:{...file('render_without_date'),subfolder:'2026_00'},createdAt:null}],selectedVersionId:'u'},
  ];
  const result = groupFoldersByMonth(history, new Map());
  assert.deepEqual(result.groups.map(group => [group.key, group.resultIds, group.subfolders]), [
    ['2026_01',['cross'],['2026_01']], ['2026_05',['invalid'],['2026_13']],
  ]);
  assert.deepEqual(result.ungroupedResultIds, ['unknown']);
});
