// iptv-org catalog — mirrors IPTVOrgExplorerView
import { getCatalog, saveCatalog, getCatalogMeta, saveCatalogMeta } from './store.js';
const MAX_AGE=24*60*60*1000;

export async function loadCatalog(force=false){
  if(!force){const meta=await getCatalogMeta();const cached=await getCatalog();if(meta&&cached.length&&(Date.now()-meta.fetchedAt)<MAX_AGE)return cached}
  try{const chs=await fetchLive();await saveCatalog(chs);await saveCatalogMeta({fetchedAt:Date.now(),count:chs.length});return chs}
  catch(e){console.warn('Catalog fetch failed:',e.message);const cached=await getCatalog();if(cached.length)return cached;throw e}
}

async function fetchLive(){
  const[cd,sd,fd]=await Promise.all([fj('https://iptv-org.github.io/api/channels.json'),fj('https://iptv-org.github.io/api/streams.json'),fj('https://iptv-org.github.io/api/feeds.json')]);
  return resolve(cd,sd,fd)
}
async function fj(u){const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}

function resolve(rawCh,rawSt,rawFe){
  const byID={};for(const c of rawCh)byID[c.id]=c;
  const lc={},lf={};
  for(const f of rawFe){if(!f.languages?.length)continue;lc[f.channel]=new Set([...(lc[f.channel]||[]),...f.languages]);lf[f.channel+':'+f.id]=new Set([...(lf[f.channel+':'+f.id]||[]),...f.languages])}
  const best={};
  for(const s of rawSt){const cid=s.channel;if(!cid)continue;const ch=byID[cid];if(!ch||ch.is_nsfw||ch.closed||s.user_agent||s.referrer)continue;if((s.label||'').toLowerCase().includes('geo-blocked'))continue;if(!s.url.toLowerCase().includes('.m3u8'))continue;const sc=parseInt((s.quality||'0').replace(/\D/g,''))||0;if(!best[cid]||sc>(best[cid]._score||0))best[cid]={...s,_score:sc}}
  const out=[];
  for(const[cid,s]of Object.entries(best)){const ch=byID[cid];if(!ch)continue;const langs=s.feed?[...(lf[cid+':'+s.feed]||[])]:[...(lc[cid]||[])];const item={id:'iptv-org:'+cid,name:ch.name,country:ch.country,categories:ch.categories||[],languages:langs.sort(),streamURL:s.url,quality:s.quality};out.push(item)}
  return out
}
