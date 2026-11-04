import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isolatedDatabase } from './database.js';
import { migrate } from '../../src/persistence/migrate.js';
import { PgStore } from '../../src/persistence/store.js';
describe.skipIf(!process.env.TEST_DATABASE_URL)('LINK03 leased booking enrichment',()=>{
 const db=isolatedDatabase(),store=new PgStore(db.pool);
 beforeAll(async()=>{await db.setup();await migrate(db.pool);});
 afterAll(()=>db.cleanup());
 it('limits separate workers to two live claims, keeps third durable, and recovers after restart',async()=>{
   await store.transaction(async tx=>{for(let i=0;i<3;i++)await tx.queue({id:randomUUID(),dedupeKey:`booking-${i}`,kind:'booking_enrichment',payload:{venueId:`v${i}`}});});
   const claims=await Promise.all(['w1','w2','w3','w4'].map(id=>store.claimBookingEnrichment(id)));
   expect(claims.filter(Boolean)).toHaveLength(2);
   expect((await db.pool.query("SELECT count(*)::int AS count FROM outbox WHERE kind='booking_enrichment' AND status='pending'")).rows[0].count).toBe(1);
   const restarted=new PgStore(db.pool);
   expect(await restarted.claimBookingEnrichment('restarted')).toBeNull();
   await db.pool.query("UPDATE outbox SET lease_until=now()-interval '1 second' WHERE kind='booking_enrichment' AND status='sending'");
   await restarted.recoverLeases();
   expect(await restarted.claimBookingEnrichment('restarted')).not.toBeNull();
   const active=await db.pool.query("SELECT count(*)::int AS count FROM outbox WHERE kind='booking_enrichment' AND status='sending' AND lease_until>now()");
   expect(active.rows[0].count).toBe(1);
 });
});
