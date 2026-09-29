import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePromptLength } from '../web/prompt-editor.mjs';
import { createPromptEditor } from '../web/prompt-editor.mjs';

// Minimal DOM contract model: checks one editor is moved, never copied or discarded.
class Element {
  constructor(tag) { this.tagName=tag; this.children=[]; this.style={}; this.dataset={}; this.events={}; this.attributes={}; this.scrollTop=0; }
  append(...children) { for(const child of children) this.appendChild(child); }
  appendChild(child) {
    child.remove?.();
    if(child.tagName==='fragment') { for(const item of [...child.children]) this.appendChild(item); return child; }
    this.children.push(child); child.parentNode=this; return child;
  }
  remove() { if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(child=>child!==this); this.parentNode=null; }
  replaceChildren(...children) { this.children=[]; this.append(...children); }
  setAttribute(key,value) { this.attributes[key]=value; }
  addEventListener(type,callback) { (this.events[type]??=[]).push(callback); }
  fire(type,event={}) { for(const handler of this.events[type]||[]) handler({stopPropagation(){},preventDefault(){},...event}); }
  contains(target) { return target===this || this.children.some(child=>child.contains?.(target)); }
  querySelectorAll() { return []; }
  querySelector(tag) { return this.children.find(child=>child.tagName===tag) || this.children.map(child=>child.querySelector?.(tag)).find(Boolean); }
  find(predicate) { return predicate(this) ? this : this.children.map(child=>child.find?.(predicate)).find(Boolean); }
  focus() { document.activeElement=this; }
  get childNodes() { return this.children; }
}

test('image toolbar dispatches only with a current image and unlocked editor', () => {
  const previous={document:globalThis.document,window:globalThis.window};
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>({textContent:text}),activeElement:null};
  globalThis.window={getSelection:()=>({rangeCount:0})};
  try {
    let root; const calls=[];
    const widget=createPromptEditor({addDOMWidget(name,type,element){root=element;return {};}},'',()=>[],()=>{}, {
      onMask:()=>calls.push('mask'),onEdit:()=>calls.push('edit'),
    });
    const buttons=root.children[0].children[0].children.slice(0,2);
    assert.deepEqual(buttons.map(button=>button.attributes['aria-label']),['蒙版重绘','图片编辑']);
    buttons.forEach(button=>button.fire('click')); assert.deepEqual(calls,[]);
    widget.setImageActionsEnabled(true);
    buttons.forEach(button=>button.fire('click')); assert.deepEqual(calls,['mask','edit']);
    widget.setDisabled(true); buttons.forEach(button=>button.fire('click')); assert.equal(calls.length,2);
    widget.setDisabled(false); widget.setImageActionsEnabled(false);
    assert.ok(buttons.every(button=>button.disabled)); widget.cleanup();
  } finally { Object.assign(globalThis,previous); }
});

test('expansion keeps the same prompt DOM, fixes compact height, changes drop target, and closes on lock/removal', () => {
  const previous={document:globalThis.document,window:globalThis.window};
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>({textContent:text}),activeElement:null};
  globalThis.window={getSelection:()=>({rangeCount:0})};
  try {
    let root,options;
    const widget=createPromptEditor({addDOMWidget(name,type,element,config){root=element;options=config;return {};}},'Keep this text',()=>[],()=>{});
    const editor=root.children[1], button=root.children[0].children[0].children.find(el=>el.attributes['aria-label']==='放大编辑提示词');
    assert.equal(options.getMinHeight(),160); assert.equal(options.getMaxHeight(),160);
    const originalTextNode=editor.children[0]; editor.scrollTop=23;
    button.fire('click');
    assert.notEqual(widget.getDropElement(),root);
    assert.ok(widget.getDropElement().contains(editor));
    assert.equal(editor.children[0],originalTextNode); assert.equal(editor.scrollTop,23);
    editor.fire('compositionstart');
    editor.fire('keydown',{key:'Escape',isComposing:true});
    assert.notEqual(widget.getDropElement(),root);
    widget.setDisabled(true);
    assert.equal(widget.getDropElement(),root); assert.equal(editor.parentNode,root);
    assert.equal(editor.contentEditable,'false'); assert.equal(button.disabled,true);
    button.fire('click'); assert.equal(widget.getDropElement(),root);
    widget.setDisabled(false); button.fire('click');
    assert.notEqual(widget.getDropElement(),root); // Force-close must not leave IME permanently active.
    widget.cleanup(); assert.equal(document.body.children.length,0);
  } finally { globalThis.document=previous.document;globalThis.window=previous.window; }
});

test('clear saves before emptying, keeps references, and reports feedback; locks reject clearing',()=>{
  const previous={document:globalThis.document,window:globalThis.window,Node:globalThis.Node};
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>({textContent:text,nodeType:3}),activeElement:null};
  globalThis.window={getSelection:()=>({rangeCount:0})};globalThis.Node={TEXT_NODE:3,ELEMENT_NODE:1};
  try{
    let root,value='keep',saved;
    const refs=[{id:'a',name:'example.png'}];
    const widget=createPromptEditor({addDOMWidget(name,type,element){root=element;return {};}},value,()=>refs,next=>value=next,{onBeforeClear:()=>saved=value});
    const clear=root.children[0].children[0].children.find(el=>el.attributes['aria-label']==='清空提示词');
    widget.setDisabled(true);clear.fire('click');assert.equal(value,'keep');
    widget.setDisabled(false);clear.fire('click');
    assert.equal(saved,'keep');assert.equal(value,'');assert.equal(refs.length,1);
    assert.equal(root.children.find(e=>e.attributes?.role==='status')?.textContent,'已清空');
    widget.cleanup();
  }finally{Object.assign(globalThis,previous);}
});

test('Escape closes the enlarged editor and returns the existing text to its compact host', () => {
  const previous={document:globalThis.document,window:globalThis.window};
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>({textContent:text}),activeElement:null};
  globalThis.window={getSelection:()=>({rangeCount:0})};
  try {
    let root;
    const widget=createPromptEditor({addDOMWidget(name,type,element){root=element;return {};}},'text',()=>[],()=>{});
    const editor=root.children[1];
    root.children[0].children[0].children.find(el=>el.attributes['aria-label']==='放大编辑提示词').fire('click');
    editor.fire('keydown',{key:'Escape'});
    assert.equal(widget.getDropElement(),root); assert.equal(editor.parentNode,root);
    assert.equal(document.activeElement,editor);
    widget.cleanup(); assert.equal(document.body.children.length,0);
  } finally { globalThis.document=previous.document;globalThis.window=previous.window; }
});

test('prompt history is a separate floating dialog and closes when generation locks or editor is removed', () => {
  const previous={document:globalThis.document,window:globalThis.window};
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>({textContent:text}),activeElement:null};
  globalThis.window={getSelection:()=>({rangeCount:0})};
  try {
    let root;
    const widget=createPromptEditor({addDOMWidget(name,type,element){root=element;return {};}},'draft',()=>[],()=>{}, {
      getPromptHistory:()=>[{id:'saved',prompt:'historical prompt',refs:[],createdAt:1}],
    });
    const button=root.children[0].children[0].children.find(el=>el.attributes['aria-label']==='提示词历史');
    button.fire('click');
    assert.equal(document.body.children.length,2);
    const overlay=document.body.children[1];
    assert.equal(overlay.children[0].attributes['aria-label'],'提示词历史');
    assert.equal(widget.getDropElement(),root);
    widget.setDisabled(true);
    assert.equal(document.body.children.length,1);
    assert.equal(button.disabled,true);
    button.fire('click'); assert.equal(document.body.children.length,1);
    widget.setDisabled(false); button.fire('click');
    widget.cleanup(); assert.equal(document.body.children.length,0);
  } finally { globalThis.document=previous.document;globalThis.window=previous.window; }
});


test('prompt weighted count follows the fixed 680-point soft limit', () => {
  assert.deepEqual(estimatePromptLength('一只猫'),{weightedCount:3,limit:680});
  assert.deepEqual(estimatePromptLength('a cat'),{weightedCount:2,limit:680});
  assert.deepEqual(estimatePromptLength('一只猫 a cat'),{weightedCount:6,limit:680});
  assert.equal(estimatePromptLength('A1,猫!').weightedCount,3.5);
  assert.equal(estimatePromptLength('🌙').weightedCount,1);
  assert.equal(estimatePromptLength('引用 [[qwen-ref:ref-1]]',[{id:'ref-1'}]).weightedCount,5.25);
});
test('optimizer opens an optional-instruction dialog and sends nothing until confirmed', () => {
  const previous={document:globalThis.document,window:globalThis.window,Node:globalThis.Node};
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment'),createTextNode:text=>({textContent:text,nodeType:3}),activeElement:null};
  globalThis.window={getSelection:()=>({rangeCount:0})};globalThis.Node={TEXT_NODE:3,ELEMENT_NODE:1};
  try{
    let root;const requests=[];
    const widget=createPromptEditor({addDOMWidget(name,type,element){root=element;return {};}},'existing prompt',()=>[],()=>{}, {onOptimize:instruction=>requests.push(instruction)});
    const optimize=root.children[0].children[0].children.find(el=>el.attributes['aria-label']==='一键优化提示词');
    optimize.fire('click');
    let dialog=document.body.find(el=>el.attributes['aria-label']==='提示词优化');
    assert.ok(dialog);assert.deepEqual(requests,[]);
    dialog.find(el=>el.textContent==='取消').onclick();assert.deepEqual(requests,[]);
    optimize.fire('click');dialog=document.body.find(el=>el.attributes['aria-label']==='提示词优化');
    dialog.find(el=>el.tagName==='textarea').value='保留构图';
    dialog.find(el=>el.textContent==='开始优化').onclick();
    assert.deepEqual(requests,['保留构图']);
    widget.cleanup();
  }finally{Object.assign(globalThis,previous);}
});
