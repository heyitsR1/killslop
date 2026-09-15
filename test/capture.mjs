// Regenerate fixtures:  node test/capture.mjs
// Trims real InnerTube `next` responses to just the parts the classifier reads.
import { writeFileSync } from 'node:fs';
const KEY='AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const UA={TVHTML5:'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15',WEB:null};
const CV={TVHTML5:'7.20240401.10.00',WEB:'2.20240401.00.00'};
async function next(id,client,hl='en'){
  const h={'content-type':'application/json'}; if(UA[client]) h['user-agent']=UA[client];
  const r=await fetch(`https://www.youtube.com/youtubei/v1/next?key=${KEY}&prettyPrint=false`,{method:'POST',headers:h,
    body:JSON.stringify({context:{client:{clientName:client,clientVersion:CV[client],hl,gl:'US'}},videoId:id})});
  return r.json();
}
function find(o,k,d=0){ if(!o||typeof o!=='object'||d>40) return undefined;
  if(Object.prototype.hasOwnProperty.call(o,k)) return o[k];
  for(const v of Object.values(o)){ const h=find(v,k,d+1); if(h!==undefined) return h; } return undefined; }
// Keep only what the classifier touches, so fixtures stay small and readable.
function trim(r){
  const vm=find(r,'howThisWasMadeSectionViewModel');
  const pri=find(r,'videoPrimaryInfoRenderer');
  const out={};
  if(vm) out.howThisWasMadeSectionViewModel={bodyHeader:vm.bodyHeader,bodyText:vm.bodyText};
  if(pri) out.videoPrimaryInfoRenderer={badges:pri.badges};
  return out;
}
const CASES=[
  ['ai-tv','9kzE8isXlQY','TVHTML5','en'],
  ['ai-web','9kzE8isXlQY','WEB','en'],
  ['ai-web-nepali','9kzE8isXlQY','WEB','ne'],
  ['autodub-tv','aDoanNM7O_s','TVHTML5','en'],
  ['autodub-web','aDoanNM7O_s','WEB','en'],
  ['clean-tv','dQw4w9WgXcQ','TVHTML5','en'],
  ['clean-web','dQw4w9WgXcQ','WEB','en'],
];
const bundle={};
for(const [name,id,client,hl] of CASES){
  bundle[name]={videoId:id,client,hl,...trim(await next(id,client,hl))};
  console.log('captured',name,Object.keys(bundle[name]).join(','));
}
writeFileSync(new URL('./fixtures/next.json',import.meta.url), JSON.stringify(bundle,null,2));
console.log('\nwrote fixtures/next.json');
