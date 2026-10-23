// Offline audit of the installed pathfinder. Does not connect to Minecraft or a model.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const requireApp = createRequire(path.resolve(__dirname, '../mindcraft/package.json'));
const {Vec3} = requireApp('vec3');
const registry = requireApp('minecraft-data')('1.21.6');
const Block = requireApp('prismarine-block')(registry);
const {Movements, goals} = requireApp('mineflayer-pathfinder');
const Move = requireApp('mineflayer-pathfinder/lib/move');
const AStar = requireApp('mineflayer-pathfinder/lib/astar');
const projectSettings = fs.readFileSync(path.resolve(__dirname, '../mindcraft/settings.js'), 'utf8');
const scaffoldEnabled = /"allow_navigation_scaffolding"\s*:\s*true/.test(projectSettings);
const xyz = v => ({x:v.x,y:v.y,z:v.z});
const moveData = v => ({...xyz(v),hash:v.hash,cost:v.cost,remainingBlocks:v.remainingBlocks,
    toBreak:v.toBreak.map(xyz),toPlace:v.toPlace.map(p=>({...p,returnPos:p.returnPos?xyz(p.returnPos):undefined})),parkour:v.parkour});

function runScenario({name, wall=false, gap=false, disableParkour=false}) {
    const cache = new Map(), queries = new Set();
    const bot = {registry,entity:{id:1,position:new Vec3(0.5,64,0.5),onGround:true,effects:{}},
        entities:{},game:{minY:-64,height:384},inventory:{items:()=>[{name:'dirt',type:registry.itemsByName.dirt.id,count:6}]},
        pathfinder:{bestHarvestTool:()=>null},blockAt(position) {
            const p=position.floored(), key=p.toString(); queries.add(key);
            const inside=gap ? p.x>=0&&p.x<=4&&p.z===0 : p.x>=-4&&p.x<=8&&p.z>=-4&&p.z<=4;
            if(!inside||p.y<60||p.y>70)return null;
            if(cache.has(key))return cache.get(key);
            const solid=p.y===63&&!(gap&&p.x===2) || wall&&p.x===2&&p.z===0&&(p.y===64||p.y===65);
            const value=Block.fromStateId(registry.blocksByName[solid?'stone':'air'].minStateId,0);
            value.position=p;cache.set(key,value);return value;
        }};
    const movements=new Movements(bot);
    movements.canDig=false;movements.allowFreeMotion=false;movements.placeCost=2;movements.digCost=10;
    movements.allow1by1towers=scaffoldEnabled;
    movements.scafoldingBlocks=scaffoldEnabled?['dirt','cobblestone'].map(n=>registry.itemsByName[n].id):[];
    if(disableParkour)movements.allowParkour=false;
    movements.clearCollisionIndex();movements.updateCollisionIndex();
    const start=new Move(0,64,0,movements.countScaffoldingItems(),0), goal=new goals.GoalBlock(4,64,0);
    const expanded=[],popped=[],getNeighbors=movements.getNeighbors.bind(movements);
    movements.getNeighbors=node=>{const neighbors=getNeighbors(node);expanded.push({from:moveData(node),neighbors:neighbors.map(moveData)});return neighbors;};
    const search=new AStar(start,movements,goal,5000,40,-1),pop=search.openHeap.pop.bind(search.openHeap);
    search.openHeap.pop=()=>{const node=pop();popped.push({...moveData(node.data),g:node.g,h:node.h,f:node.f,parent:node.parent?xyz(node.parent.data):null});return node;};
    let result=search.compute();const slices=[{status:result.status,timeMs:result.time}];
    while(result.status==='partial'){result=search.compute();slices.push({status:result.status,timeMs:result.time});}
    assert.equal(result.status,'success');
    const worldSamples=[new Vec3(1,63,0),new Vec3(1,64,0),new Vec3(2,64,0)].map(p=>{
        const b=movements.getBlock(p,0,0,0);return {...xyz(p),name:b.name,stateId:b.stateId,boundingBox:b.boundingBox,
            shapes:b.shapes,safe:b.safe,physical:b.physical,liquid:b.liquid,climbable:b.climbable,height:b.height,openable:b.openable};
    });
    return {name,scope:'Synthetic local world with real Minecraft 1.21.6 block states and the installed Movements/AStar; no live movement.',
        scenarioOverrides:disableParkour?{allowParkour:false,reason:'Isolate block placement instead of the normal parkour alternative.'}:{},
        start:moveData(start),goal:{type:'GoalBlock',x:4,y:64,z:0},
        settings:{canDig:movements.canDig,placeCost:movements.placeCost,digCost:movements.digCost,allow1by1towers:movements.allow1by1towers,
            allowParkour:movements.allowParkour,allowSprinting:movements.allowSprinting,maxDropDown:movements.maxDropDown,
            infiniteLiquidDropdownDistance:movements.infiniteLiquidDropdownDistance,searchRadius:-1,tickBudgetMs:40,searchBudgetMs:5000},
        map:wall?['.....','.....','S.#.G','.....','.....']:gap?['S._.G (floor gap at x=2)']:['S...G'],
        worldSamples,status:result.status,totalCost:result.cost,visitedNodes:result.visitedNodes,generatedNodes:result.generatedNodes,
        queriedBlockCoordinates:queries.size,slices,rawPath:result.path.map(moveData),popSequence:popped,expanded};
}
const scenarios=[runScenario({name:'flat'}),runScenario({name:'two-block-high-obstacle',wall:true}),
    runScenario({name:'one-block-gap-normal-parkour',gap:true}),runScenario({name:'one-block-gap-placement-isolated',gap:true,disableParkour:true})];
assert.equal(scenarios[0].totalCost,4);
assert(Math.abs(scenarios[1].totalCost-(2+2*Math.SQRT2))<1e-9);
assert(scenarios[1].rawPath.every(n=>!(n.x===2&&n.z===0&&n.y<66)));
assert.equal(scenarios[2].totalCost,3);assert(scenarios[2].rawPath.some(n=>n.parkour));
assert.equal(scenarios[3].totalCost,6);assert.equal(scenarios[3].rawPath.reduce((sum,n)=>sum+n.toPlace.length,0),1);
for(const scenario of scenarios)assert(Math.abs(scenario.rawPath.reduce((sum,n)=>sum+n.cost,0)-scenario.totalCost)<1e-9);
const report={at:new Date().toISOString(),installed:{mineflayer:requireApp('mineflayer/package.json').version,
    pathfinder:requireApp('mineflayer-pathfinder/package.json').version,physics:requireApp('prismarine-physics/package.json').version,mcVersion:'1.21.6'},
    sourceSha256:Object.fromEntries(['lib/astar.js','lib/move.js','lib/movements.js','lib/physics.js','index.js'].map(file=>[file,
        createHash('sha256').update(fs.readFileSync(requireApp.resolve('mineflayer-pathfinder/'+file))).digest('hex')])),
    checksPassed:true,note:'Raw graph nodes before block-surface centering and execution. Minecraft-world fixtures are fabricated; algorithm output is real.',scenarios};
const destination=path.resolve(__dirname,'land-navigation-data-trace-20261023.json');
fs.writeFileSync(destination,JSON.stringify(report,null,2));
console.log(JSON.stringify({destination,installed:report.installed,scenarios:scenarios.map(s=>({name:s.name,status:s.status,cost:s.totalCost,
    visited:s.visitedNodes,generated:s.generatedNodes,rawPath:s.rawPath.map(n=>({...xyz(n),cost:n.cost,parkour:n.parkour,placements:n.toPlace.length})),
    firstPopSequence:s.popSequence.slice(0,6).map(n=>({...xyz(n),g:n.g,h:n.h,f:n.f}))}))},null,2));
