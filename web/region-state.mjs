const COLORS={red:'红色',green:'绿色',blue:'蓝色',yellow:'黄色'};

export function regionOfImage(bounds,width,height){
  if(!bounds)return '中央';
  const mx=width/2,my=height/2,x1=Math.min(bounds.x1,bounds.x2),x2=Math.max(bounds.x1,bounds.x2),y1=Math.min(bounds.y1,bounds.y2),y2=Math.max(bounds.y1,bounds.y2);
  const crossX=x1<=mx&&x2>=mx,crossY=y1<=my&&y2>=my;
  if(crossX&&crossY)return '中央';
  if(crossX)return y2<my?'上方':'下方';
  if(crossY)return x2<mx?'左侧':'右侧';
  const right=(x1+x2)/2>mx,bottom=(y1+y2)/2>my;
  return `${right?'右':'左'}${bottom?'下':'上'}角`;
}

export function regionPrompt(region,referenceId){
  const lines=[];
  if(region.instruction?.trim()){
    const bounds=region.maskBounds;
    lines.push(bounds?`在图片${regionOfImage(bounds,region.width,region.height)}的紫色标注区域：${region.instruction.trim()}`:`${region.instruction.trim()}`);
  }
  const layers=Array.isArray(region.annotationLayers)
    ?region.annotationLayers.filter(layer=>layer.marks?.length).map(layer=>({text:layer.text,color:layer.color,bounds:layer.bounds}))
    :(region.annotations||[]);
  for(const mark of layers){
    if(!mark.text?.trim())continue;
    lines.push(`在图片${regionOfImage(mark.bounds,region.width,region.height)}的${COLORS[mark.color]||'彩色'}标注区域：${mark.text.trim()}`);
  }
  return lines.join('\n');
}

export function replaceRegionPrompt(prompt,previous,next){
  if(previous&&!prompt.includes(previous))throw new Error('区域说明已被手动修改，请确认替换');
  return previous?prompt.replace(previous,next):[prompt.trim(),next].filter(Boolean).join('\n\n');
}

export function regionForSubmission(region,refs){
  if(!region)return '';
  const first=refs[0];
  if(!first||first.name!==region.source.name||first.type!==region.source.type)throw new Error('区域编辑的来源图片必须保持为第一张参考图，请恢复来源图片或退出编辑');
  if(refs.length>=10)throw new Error('区域编辑需要一张辅助图，请将参考图减至最多9张');
  return JSON.stringify(region);
}
