// Speelt een volledige match AI tegen AI zonder browser (bewijst dat de simulatie servergeschikt is
// en is handig om balans en AI te testen).
//
//   node tools/headless-match.mjs [seed] [--quiet]
import { CONFIG } from '../src/config.js';
import { generateMap } from '../src/sim/mapGen.js';
import { GameWorld, createCommand } from '../src/sim/world.js';
import { NavGrid } from '../src/ai/navGrid.js';
import { AICoordinator } from '../src/ai/ai.js';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const seedArg = args.find((a) => /^\d+$/.test(a));
const config = structuredClone(CONFIG);
if (seedArg) config.map.seed = Number(seedArg);

let t0 = performance.now();
const map = generateMap(config);
const tMap = performance.now() - t0;
t0 = performance.now();
const nav = new NavGrid(map, config);
const tNav = performance.now() - t0;
const walkable = nav.walk.reduce((a, b) => a + b, 0) / nav.walk.length;
console.log(
  `kaart: ${map.trees.length} bomen (${map.trees.filter((t) => !t.border).length} in speelveld), ` +
    `${map.rocks.length} rotsen, ${map.roads.length} wegen, ${map.meadows.length} open plekken ` +
    `| gen ${tMap.toFixed(0)} ms, navgrid ${tNav.toFixed(0)} ms, begaanbaar ${(walkable * 100).toFixed(0)}%`,
);
for (const p of map.points) console.log(`  punt ${p.id}: (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) h=${p.y.toFixed(1)}`);

const names = config.ai.names;
const roster = [];
for (let team = 0; team < 2; team++) {
  for (let i = 0; i < config.match.playersPerTeam; i++) roster.push({ team, name: names[team * 4 + i], isPlayer: false });
}
const world = new GameWorld(map, config, roster);
const ai = new AICoordinator(world, nav);
for (const tank of world.tanks) ai.add(tank, config.map.seed * 31 + tank.id * 7919);
const commands = world.tanks.map(() => createCommand());

const dt = 1 / config.sim.tickRate;
const counts = { shots: 0, hits: 0, kills: 0, captures: 0, neutralized: 0 };
let stepTime = 0;
let steps = 0;
let lastReport = 0;
const maxTime = config.match.timeLimit + config.match.startCountdown + 5;
while (world.phase !== 'ended' && world.time < maxTime) {
  const s = performance.now();
  ai.update(dt, commands);
  world.step(dt, commands);
  stepTime += performance.now() - s;
  steps++;
  for (const e of world.drainEvents()) {
    if (e.type === 'shotFired') counts.shots++;
    else if (e.type === 'tankHit') counts.hits++;
    else if (e.type === 'tankDestroyed') {
      counts.kills++;
      if (!quiet) {
        const v = world.tanks[e.tankId];
        const k = world.tanks[e.killerId];
        console.log(`[${world.battleTime.toFixed(0).padStart(4)}s] ${k ? k.name : '?'} vernietigt ${v.name}`);
      }
    } else if (e.type === 'pointCaptured') {
      counts.captures++;
      if (!quiet) console.log(`[${world.battleTime.toFixed(0).padStart(4)}s] punt ${e.pointId} veroverd door ${config.teams[e.team].name}`);
    } else if (e.type === 'pointNeutralized') counts.neutralized++;
    else if (e.type === 'matchEnd') {
      console.log(`EINDE: winnaar ${e.winner >= 0 ? config.teams[e.winner].name : 'gelijkspel'} (${e.reason})`);
    }
  }
  if (world.battleTime - lastReport >= 60) {
    lastReport = world.battleTime;
    const pts = world.points.map((p) => `${p.id}:${p.owner === -1 ? '-' : config.teams[p.owner].name[0]}`).join(' ');
    console.log(
      `  -- ${Math.round(world.battleTime)}s tickets ${world.teams[0].tickets.toFixed(0)} / ${world.teams[1].tickets.toFixed(0)}  ${pts}`,
    );
  }
}
console.log(
  `duur ${(world.battleTime / 60).toFixed(1)} min | tickets ${world.teams[0].tickets.toFixed(0)} - ${world.teams[1].tickets.toFixed(0)} | ` +
    `schoten ${counts.shots}, treffers ${counts.hits}, kills ${counts.kills}, veroveringen ${counts.captures}, geneutraliseerd ${counts.neutralized}`,
);
console.log(`simulatie: ${(stepTime / steps).toFixed(3)} ms per stap (${steps} stappen)`);
for (const c of ai.controllers) {
  const t = c.tank;
  console.log(
    `  ${config.teams[t.team].name.padEnd(5)} ${t.name.padEnd(9)} K ${t.kills} D ${t.deaths} C ${t.captures} ` +
      `schade ${Math.round(t.damageDealt)} | vast ${c.stats.stuckEvents}x, paden ${c.stats.repaths}, mislukt ${c.stats.pathFailures}`,
  );
}
