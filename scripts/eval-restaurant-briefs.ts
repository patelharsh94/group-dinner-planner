/** Public, read-only live evaluation. Never loads or mutates a dinner. */
import { readFile, writeFile } from 'node:fs/promises';
import { MuseClient } from '../src/adapters/muse.js';
const corpus=JSON.parse(await readFile(new URL('../evals/restaurant-briefs-v1.json',import.meta.url),'utf8'));
const mode=process.argv[2]??'gaijin';
const cases=mode==='corpus'?corpus.cases:Array.from({length:5},()=>corpus.cases[0]);
if(!process.env.MODEL_API_KEY)throw new Error('MODEL_API_KEY required');
const client=new MuseClient({apiKey:process.env.MODEL_API_KEY,baseUrl:process.env.MUSE_BASE_URL,model:process.env.MUSE_MODEL});
const results:unknown[]=[];let cursor=0;
await Promise.all(Array.from({length:2},async()=>{while(cursor<cases.length){const index=cursor++,target=cases[index],before=Date.now();try{
const result=await client.research({targetVenue:target,setup:{city:target.city,area:'City',windowStart:'2026-11-07',windowEnd:'2026-11-07',timezone:'America/Chicago',timezoneConfirmed:true,currency:'USD',currencyConfirmed:true,durationMinutes:90,budget:{amount:60,basis:'per-person'},intendedAttendees:['public-eval-a','public-eval-b']},slots:[{start:'2026-11-07T19:00:00-06:00',end:'2026-11-07T20:30:00-06:00'}],dietary:[{requirement:'vegetarian',allergy:false}],travel:[],partySize:2},new Date().toISOString());
const brief=result.venues[0]?.brief;const complete=!!brief&&[brief.address,brief.hours,brief.booking,brief.dietary].every(x=>x.status==='complete');
results.push({index,name:target.name,durationMs:Date.now()-before,complete,brief,phases:result.phases,providerCalls:result.providerCalls});console.log(JSON.stringify({index,name:target.name,complete,durationMs:Date.now()-before,statuses:brief&&[brief.address.status,brief.hours.status,brief.booking.status,brief.dietary.status]}));
}catch(e){results.push({index,name:target.name,durationMs:Date.now()-before,error:e instanceof Error?e.name:'error'});console.log(JSON.stringify({index,name:target.name,error:e instanceof Error?e.name:'error'}));}}}));
const path=process.argv[3]??`/tmp/restaurant-brief-${mode}.json`;await writeFile(path,JSON.stringify(results,null,2));console.log(JSON.stringify({mode,cases:results.length,complete:results.filter((r:any)=>r.complete&&r.durationMs<=90000).length,publicResultsFile:path}));
