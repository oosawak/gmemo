const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Run the actual inline application against a tiny DOM and simulated Drive responses.
// No Google credentials, browser packages, or network access are needed.
class Element {
  constructor(tag='div') { this.localName=tag; this.children=[]; this.value=''; this.hidden=false; this.disabled=false; this.textContent=''; this.dataset={}; this.attributes={}; this.classList={toggle(){},add(){},remove(){}}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  setAttribute(key,value) { this.attributes[key]=value; }
  focus() {}
  scrollIntoView() { this.scrolled=true; }
}
function app(responses=[],ai=false) {
  const html=fs.readFileSync(new URL('../index.html',`file://${__filename}`),'utf8');
  const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const elements=new Map(); const storage=new Map(); const calls=[];const metadataCalls=[];
  const fixtures=new Map([
    ['folder-1',{id:'folder-1',name:'gmemo',mimeType:'application/vnd.google-apps.folder',parents:['my-root'],capabilities:{canAddChildren:true}}],
    ...['note-id','created-id','original'].map(id=>[id,{id,name:'資料.md',mimeType:'text/markdown',parents:['folder-1'],capabilities:{canEdit:true}}])
  ]);
  const context=vm.createContext({
    document:{ body:{dataset:{mode:ai?'ai':''}},getElementById(id){ if(!elements.has(id)) elements.set(id,new Element()); return elements.get(id); }, querySelectorAll(){return [];}, createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),createDocumentFragment:()=>new Element('fragment') },
    window:{addEventListener(){}},location:{protocol:'http:',origin:'http://localhost:8000',href:'http://localhost:8000/index.html',hash:''},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    Blob,URL,URLSearchParams,Date,setTimeout,confirm:()=>true,
    fetch:async(url,options)=>{const parsed=new URL(url);const id=parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/)?.[1];if(id&&parsed.searchParams.get('alt')!=='media'&&fixtures.has(id)){metadataCalls.push({url,options});return response(fixtures.get(id));}calls.push({url,options});const result=responses.shift();if(!result)throw new Error(`Unexpected request: ${url}`);if(result instanceof Error)throw result;return result;}
  });
  vm.runInContext(script,context,{filename:'index.html'});
  vm.runInContext("state.token='test';state.expires=Date.now()+3600000;state.connected=true;state.folder={id:'folder-1',name:'メモ',capabilities:{canAddChildren:true}};state.folder=Object.assign(state.folder,{mimeType:'application/vnd.google-apps.folder'});state.baseFolder=state.folder;state.baseName='gmemo';state.trail=[state.folder];",context);
  return {run:code=>vm.runInContext(code,context),el:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},calls,storage,fixtures,metadataCalls};
}
function response(data={},status=200,headers={}) { return {ok:status>=200&&status<300,status,statusText:'error',headers:new Headers(headers),json:async()=>data,text:async()=>typeof data==='string'?data:JSON.stringify(data)}; }
const session=(id='session-1')=>response({},200,{Location:`https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}`});

test('file-only registration creates one file and no empty Markdown',async()=>{
  const a=app([session(),response({id:'photo-id',name:'photo.jpg'}),response({files:[]})]);
  a.run("state.queue=[{file:Object.assign(new Blob(['photo'],{type:'image/jpeg'}),{name:'photo.jpg'}),session:null,offset:0}]");
  await a.run('save()');
  assert.equal(a.calls.filter(c=>c.options.method==='POST').length,1);
  assert.deepEqual(JSON.parse(a.calls[0].options.body),{name:'photo.jpg',parents:['folder-1'],mimeType:'image/jpeg'});
  assert.equal(a.run('state.queue.length'),0);
  assert.equal(a.run('state.note'),null);
  assert.equal(a.el('body').value,'');
});

test('attachment links are included in Markdown and existing notes update using PATCH',async()=>{
  const a=app([session('attachment'),response({id:'asset-id',name:'a[b].pdf'}),session('note'),response({id:'note-id',name:'会議.md'}),response({files:[]})]);
  a.el('title').value='会議'; a.el('body').value='# 議事録';
  a.run("state.note={id:'note-id',parentId:'folder-1',destination:'メモ',capabilities:{canEdit:true}};state.queue=[{file:Object.assign(new Blob(['pdf']),{name:'a[b].pdf'}),session:null,offset:0}]");
  await a.run('save()');
  assert.equal(a.calls[2].options.method,'PATCH');
  assert.match(a.calls[2].url,/\/note-id\?/);
  assert.equal(a.el('body').value,'# 議事録\n\n[a\\[b\\].pdf](https://drive.google.com/file/d/asset-id/view)');
  assert.equal(await a.calls[3].options.body.text(),a.el('body').value);
  assert.equal(a.run('state.dirty'),false);
});

test('workspace subfolder listing follows pagination and respects read-only permissions',async()=>{
  const a=app([response({files:[{id:'f1',name:'AI',mimeType:'application/vnd.google-apps.folder'}],nextPageToken:'next'}),response({files:[{id:'f2',name:'Music',mimeType:'application/vnd.google-apps.folder'}]})]);
  a.fixtures.set('sub',{id:'sub',name:'チーム',mimeType:'application/vnd.google-apps.folder',parents:['folder-1'],capabilities:{canAddChildren:false}});
  await a.run("browse({id:'sub'})");
  const params=new URL(a.calls[0].url).searchParams;
  assert.equal(params.get('corpora'),'user');
  assert.equal(params.get('driveId'),null);
  assert.equal(params.get('supportsAllDrives'),'true');
  assert.equal(params.get('includeItemsFromAllDrives'),'true');
  assert.equal(new URL(a.calls[1].url).searchParams.get('pageToken'),'next');
  assert.equal(a.run('state.files.length'),2);
  a.el('body').value='test'; a.run('updateUI()');
  assert.equal(a.el('save').disabled,true);
  assert.equal(a.el('new-folder').disabled,true);
});

test('lost response after create is resolved before saving edited text to the same ID',async()=>{
  const a=app([session('original'),new Error('connection lost'),response({id:'created-id',name:'旧.md'}),session('update'),response({id:'created-id',name:'新.md'}),response({files:[]})]);
  a.el('title').value='旧'; a.el('body').value='first';
  await assert.rejects(a.run('save()'),/connection lost/);
  a.el('title').value='新'; a.el('body').value='second'; a.run('changed()');
  await a.run('save()');
  assert.equal(a.calls[2].options.headers['Content-Range'],'bytes */5');
  assert.equal(a.calls[3].options.method,'PATCH');
  assert.match(a.calls[3].url,/\/created-id\?/);
  assert.equal(a.calls.filter(c=>c.options.method==='POST').length,1);
  assert.equal(await a.calls[4].options.body.text(),'second');
});

test('partial attachment success is kept and failed attachment resumes without uploading completed files again',async()=>{
  const a=app([session('one'),response({id:'one',name:'one.bin'}),session('two'),new Error('offline'),response({},308,{Range:'bytes=0-1'}),response({id:'two',name:'two.bin'}),response({files:[]})]);
  a.run("state.queue=['one','two'].map(name=>({file:Object.assign(new Blob(['data']),{name:name+'.bin'}),session:null,offset:0}))");
  await assert.rejects(a.run('save()'),/offline/);
  assert.equal(a.run('state.queue.length'),1);
  assert.equal(a.run('state.queue[0].file.name'),'two.bin');
  await a.run('save()');
  assert.equal(a.calls[4].options.headers['Content-Range'],'bytes */4');
  assert.equal(a.calls[5].options.headers['Content-Range'],'bytes 2-3/4');
  assert.equal(a.calls.filter(c=>c.options.method==='POST').length,2);
});

test('expired authentication leaves input and upload queue intact',async()=>{
  const a=app(); a.el('body').value='消えないメモ';
  a.run("state.expires=0;state.queue=[{file:new Blob(['data'])}]");
  await assert.rejects(a.run('save()'),/有効期限/);
  assert.equal(a.el('body').value,'消えないメモ');
  assert.equal(a.run('state.queue.length'),1);
  assert.equal(a.calls.length,0);
});

test('Markdown preview keeps HTML as text and never creates executable links',()=>{
  const a=app(); a.el('body').value='<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n[ok](https://example.com)';
  a.run('renderPreview()');
  function walk(node){return [node,...(node.children||[]).flatMap(walk)];}
  const nodes=walk(a.el('preview'));
  assert.equal(nodes.some(n=>n.localName==='img'||n.localName==='script'),false);
  assert.equal(nodes.filter(n=>n.localName==='a').length,1);
  assert.equal(nodes.find(n=>n.localName==='a').href,'https://example.com');
});

test('AI lookup reads exactly the specified Markdown and its parent, with no Drive listing',async()=>{
  const a=app([
    response({id:'target',name:'対象.md',mimeType:'text/markdown',parents:['team-folder'],capabilities:{canEdit:true}}),
    response({id:'team-folder',name:'チーム',mimeType:'application/vnd.google-apps.folder',parents:['folder-1'],capabilities:{canAddChildren:true}}),
    response('# 指定された本文')
  ],true);
  a.el('ai-key').value='https://drive.google.com/file/d/target/view';
  await a.run('aiGet()');
  assert.equal(a.calls.length,3);
  assert.ok(a.calls.every(c=>new URL(c.url).pathname.startsWith('/drive/v3/files/')));
  assert.equal(a.el('body').value,'# 指定された本文');
  assert.equal(a.run('state.note.id'),'target');
  const result=JSON.parse(a.el('ai-result').value);
  assert.equal(result.ok,true);
  assert.equal(result.file.id,'target');
  assert.equal(result.content,'Markdown本文欄');
  assert.ok(!a.el('ai-result').value.includes('# 指定された本文'));
});

test('AI binary lookup does not download bytes or list the containing folder automatically',async()=>{
  const a=app([response({id:'pdf',name:'資料.pdf',mimeType:'application/pdf',parents:['p'],capabilities:{canEdit:false,canDownload:true}}),response({id:'p',name:'共有フォルダ',parents:['folder-1'],mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:false}})],true);
  a.el('ai-key').value='pdf';await a.run('aiGet()');a.run('updateUI()');
  assert.equal(a.calls.length,2);
  assert.equal(a.el('body').value,'');
  assert.equal(a.el('ai-replace').disabled,true);
  assert.equal(a.el('ai-download').disabled,false);
});

test('AI file replacement preserves file ID and original name without creating a new file',async()=>{
  const a=app([session('replace'),response({id:'original',name:'資料.pdf'})],true);
  a.run("state.source={id:'original',name:'資料.pdf',mimeType:'application/pdf',capabilities:{canEdit:true}};state.queue=[{file:Object.assign(new Blob(['updated'],{type:'application/pdf'}),{name:'修正版.pdf'}),session:null,offset:0}]");
  await a.run('aiReplace()');
  assert.equal(a.calls[0].options.method,'PATCH');
  assert.match(a.calls[0].url,/\/original\?/);
  assert.equal(JSON.parse(a.calls[0].options.body).name,'資料.pdf');
  assert.equal(JSON.parse(a.el('ai-result').value).file.id,'original');
  assert.equal(a.run('state.queue.length'),0);
});

test('AI URLs resolve to their Drive ID and reject unrelated external URLs',()=>{
  const a=app();
  assert.equal(a.run("parseReference('http://localhost:8000/ai.html#file=abc_123&resourcekey=key').id"),'abc_123');
  assert.equal(a.run("parseReference('https://docs.google.com/document/d/abc_123/edit').id"),'abc_123');
  assert.throws(()=>a.run("parseReference('https://example.com/file/d/abc_123')"),/対応する/);
});

test('AI authentication never falls back to the human OAuth client ID',()=>{
  const human=app();const ai=app([],true);
  for(const a of [human,ai])a.storage.set('gmemo.clientId','human.apps.googleusercontent.com');
  assert.equal(human.run('clientId()'),'human.apps.googleusercontent.com');
  assert.equal(ai.run('clientId()'),'');
  ai.storage.set('gmemo.ai.clientId','agent.apps.googleusercontent.com');
  assert.equal(ai.run('clientId()'),'agent.apps.googleusercontent.com');
  assert.equal(human.run('clientId()'),'human.apps.googleusercontent.com');
});

test('initial folder defaults to gmemo and is created under My Drive without listing unrelated files',async()=>{
  const a=app([response({files:[]}),response({id:'new-base',name:'gmemo',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}})]);
  a.storage.set('gmemo.initialFolder','   ');
  await a.run('ensureWorkspace()');
  const query=new URL(a.calls[0].url).searchParams.get('q');
  assert.match(query,/'root' in parents/);assert.match(query,/name = 'gmemo'/);assert.match(query,/mimeType = 'application\/vnd.google-apps.folder'/);
  assert.deepEqual(JSON.parse(a.calls[1].options.body),{name:'gmemo',mimeType:'application/vnd.google-apps.folder',parents:['root']});
  assert.equal(a.run('state.baseFolder.id'),'new-base');
});

test('configured initial folder is reused and ambiguous duplicate names stop without creating another',async()=>{
  const folder={id:'existing',name:"my'notes",mimeType:'application/vnd.google-apps.folder'};
  const a=app([response({files:[folder]})]);a.storage.set('gmemo.initialFolder',"my'notes");await a.run('ensureWorkspace()');
  assert.equal(a.calls.length,1);assert.equal(a.run('state.baseFolder.id'),'existing');
  assert.ok(new URL(a.calls[0].url).searchParams.get('q').includes("name = 'my\\'notes'"));
  const b=app([response({files:[folder,{...folder,id:'duplicate'}]})]);
  await assert.rejects(b.run('ensureWorkspace()'),/複数/);assert.equal(b.calls.length,1);
});

test('My Drive and sibling folders cannot be listed through folder IDs',async()=>{
  for(const id of ['root','sibling']) {
    const a=app();a.fixtures.set(id,{id,name:'outside',mimeType:'application/vnd.google-apps.folder',parents:id==='root'?[]:['root']});
    await assert.rejects(a.run(`browse({id:'${id}'})`),/初期フォルダー.*外/);
    assert.equal(a.calls.length,0);assert.equal(a.run('state.folder.id'),'folder-1');
  }
});

test('AI rejects external Markdown before reading bytes or displaying its name',async()=>{
  const a=app([],true);a.fixtures.set('outside',{id:'outside',name:'private.md',mimeType:'text/markdown',parents:['root']});a.el('ai-key').value='outside';
  await assert.rejects(a.run('aiGet()'),/初期フォルダー.*外/);
  assert.equal(a.calls.length,0);assert.equal(a.el('body').value,'');assert.equal(a.run('state.source'),null);
});

test('downloads and updates recheck ancestry when a file has moved outside the initial folder',async()=>{
  for(const operation of ['aiDownload()','aiReplace()']) {
    const a=app([],true);a.fixtures.set('moved',{id:'moved',name:'file.pdf',mimeType:'application/pdf',parents:['root'],capabilities:{canEdit:true}});
    a.run("state.source={id:'moved',name:'file.pdf',mimeType:'application/pdf',capabilities:{canEdit:true}};state.queue=[{file:new Blob(['data']),session:null,offset:0}]");
    await assert.rejects(a.run(operation),/初期フォルダー.*外/);assert.equal(a.calls.length,0);assert.equal(a.run('state.queue.length'),1);
  }
});

test('folder shortcuts cannot escape to a location outside the initial folder',async()=>{
  const a=app();a.fixtures.set('outside',{id:'outside',name:'outside',mimeType:'application/vnd.google-apps.folder',parents:['root']});
  await assert.rejects(a.run("openFile({id:'shortcut',mimeType:'application/vnd.google-apps.shortcut',shortcutDetails:{targetId:'outside',targetMimeType:FOLDER}})"),/初期フォルダー.*外/);
  assert.equal(a.calls.length,0);
});

test('breadcrumb paths start at the initial folder and settings changes require reconnection',async()=>{
  const a=app([response({files:[]})]);a.fixtures.set('sub',{id:'sub',name:'sub',mimeType:'application/vnd.google-apps.folder',parents:['folder-1'],capabilities:{canAddChildren:true}});
  await a.run("browse({id:'sub'},[{id:'root',name:'マイドライブ'},{id:'sub'}])");
  assert.equal(a.run('state.trail.map(f=>f.id).join(",")'),'folder-1,sub');
  a.storage.set('gmemo.initialFolder','other');await assert.rejects(a.run("scopedFile('sub')"),/再接続/);
});

test('human Markdown edit action loads the selected file into the visible editor and saves to the same ID',async()=>{
  const a=app([response('# 保存済みの本文'),response({files:[]}),session('edit'),response({id:'note-id',name:'資料.md'}),response({files:[]})]);
  a.run("state.files=[{id:'note-id',name:'資料.md',mimeType:'text/markdown',capabilities:{canEdit:true}}];renderLibrary()");
  a.el('body').hidden=true;a.el('preview').hidden=false;
  const row=a.el('files').children[0];
  assert.equal(row.children.some(node=>node.localName==='a'),false);
  const edit=row.children.find(node=>node.attributes['aria-label']==='資料.mdをメモ欄で編集');
  assert.ok(edit);await edit.onclick();
  assert.equal(a.el('title').value,'資料');assert.equal(a.el('body').value,'# 保存済みの本文');
  assert.equal(a.el('body').hidden,false);assert.equal(a.el('preview').hidden,true);
  assert.equal(a.el('editor-label').textContent,'編集中：資料.md');
  assert.equal(a.el('save').textContent,'変更を保存 ↑');assert.equal(a.el('save').disabled,false);
  assert.equal(a.el('memo-editor').scrolled,true);
  a.el('body').value='# 編集した本文';a.run('changed()');await a.run('save()');
  const update=a.calls.find(call=>call.options.method==='PATCH');
  assert.match(update.url,/\/note-id\?/);assert.equal(a.run('state.note.id'),'note-id');
});

test('human read-only Markdown is displayed in the memo area without enabling cloud save',async()=>{
  const a=app([response('# 読み取り専用'),response({files:[]})]);
  a.fixtures.set('readonly',{id:'readonly',name:'共有.md',mimeType:'text/markdown',parents:['folder-1'],capabilities:{canEdit:false}});
  await a.run("openFile({id:'readonly',name:'共有.md',mimeType:'text/markdown'})");
  assert.equal(a.el('body').value,'# 読み取り専用');assert.equal(a.el('body').hidden,false);
  assert.equal(a.el('save').disabled,true);assert.match(a.el('editor-label').textContent,/読み取り専用/);
});

test('Markdown MIME types and shortcuts open the actual Markdown in the memo editor',async()=>{
  const a=app([response('Markdown without extension'),response({files:[]})]);
  a.fixtures.set('target-md',{id:'target-md',name:'メモ',mimeType:'text/markdown',parents:['folder-1'],capabilities:{canEdit:true}});
  await a.run("openFile({id:'shortcut',name:'メモへのリンク',mimeType:'application/vnd.google-apps.shortcut',shortcutDetails:{targetId:'target-md',targetMimeType:'text/markdown'}})");
  assert.equal(a.el('body').value,'Markdown without extension');assert.equal(a.run('state.note.id'),'target-md');
});
