// Display-only translations. Protocol identifiers and configuration values stay unchanged.
function zhGameMode(value) {
    return ({ survival: '生存', creative: '创造', adventure: '冒险', spectator: '旁观' })[value] || value;
}

function zhAction(value) {
    const names = {
        Idle: '空闲', Acting: '执行中', Chatting: '交谈中', Stopped: '等待指令', Thinking: '思考中',
        self_preservation: '紧急避险', self_defense: '自动防御', cowardice: '远离敌人', unstuck: '尝试脱困',
        item_collecting: '拾取物品', hunting: '狩猎', torch_placing: '放置火把', elbow_room: '保持距离', idle_staring: '观察周围',
        followPlayer: '跟随玩家', goToPlayer: '前往玩家身边', teleportToPlayer: '传送到玩家身边', goToCoordinates: '前往指定坐标',
        teleportPlayerToCoordinates: '传送指定玩家到坐标', teleportPlayerToPlayer: '传送指定玩家到另一玩家',
        collectBlocks: '采集方块', craftRecipe: '合成物品', smeltItem: '熔炼物品', moveAway: '撤离当前位置',
        goToBed: '上床睡觉', stay: '原地等待', eat: '进食', searchForBlock: '寻找方块',
        pickupItems: '拾取物品', givePlayer: '交付物品', equip: '装备物品', placeBlock: '放置方块',
        attack: '攻击', fish: '钓鱼', tillAndSow: '耕种', activate: '使用物品',
    };
    if (!value) return '空闲';
    if (value.startsWith('Chatting with ')) return `正在与 ${value.slice(14)} 交谈`;
    const key = value.replace(/^(action|mode):/, '');
    return names[key] || value;
}

function zhBiome(value) {
    const names = {
        plains: '平原', sunflower_plains: '向日葵平原', forest: '森林', flower_forest: '繁花森林',
        birch_forest: '桦木森林', old_growth_birch_forest: '原始桦木森林', dark_forest: '黑森林', pale_garden: '苍白之园',
        taiga: '针叶林', snowy_taiga: '积雪针叶林', old_growth_pine_taiga: '原始松木针叶林', old_growth_spruce_taiga: '原始云杉针叶林',
        jungle: '丛林', sparse_jungle: '稀疏丛林', bamboo_jungle: '竹林', swamp: '沼泽', mangrove_swamp: '红树林沼泽',
        desert: '沙漠', savanna: '热带草原', savanna_plateau: '热带高原', windswept_savanna: '风袭热带草原',
        badlands: '恶地', eroded_badlands: '风蚀恶地', wooded_badlands: '疏林恶地',
        meadow: '草甸', cherry_grove: '樱花树林', grove: '雪林', snowy_slopes: '积雪山坡',
        jagged_peaks: '尖峭山峰', frozen_peaks: '冰封山峰', stony_peaks: '裸岩山峰',
        snowy_plains: '雪原', ice_spikes: '冰刺之地', windswept_hills: '风袭丘陵', windswept_forest: '风袭森林', windswept_gravelly_hills: '风袭沙砾丘陵',
        river: '河流', frozen_river: '冻河', beach: '沙滩', snowy_beach: '积雪沙滩', stony_shore: '石岸',
        ocean: '海洋', deep_ocean: '深海', warm_ocean: '暖水海洋', lukewarm_ocean: '温水海洋', deep_lukewarm_ocean: '温水深海',
        cold_ocean: '冷水海洋', deep_cold_ocean: '冷水深海', frozen_ocean: '冻洋', deep_frozen_ocean: '冰冻深海',
        mushroom_fields: '蘑菇岛', lush_caves: '繁茂洞穴', dripstone_caves: '溶洞', deep_dark: '深暗之域',
        nether_wastes: '下界荒地', soul_sand_valley: '灵魂沙峡谷', crimson_forest: '绯红森林', warped_forest: '诡异森林', basalt_deltas: '玄武岩三角洲',
        the_end: '末地', end_highlands: '末地高地', end_midlands: '末地内陆', small_end_islands: '末地小型岛屿', end_barrens: '末地荒地', the_void: '虚空',
    };
    return names[String(value).replace(/^minecraft:/, '')] || value;
}

function zhItem(value) {
    const names = {
        dirt: '泥土', grass_block: '草方块', stone: '石头', cobblestone: '圆石', sand: '沙子', gravel: '沙砾',
        stick: '木棍', crafting_table: '工作台', furnace: '熔炉', chest: '箱子', torch: '火把', coal: '煤炭', charcoal: '木炭',
        raw_iron: '粗铁', iron_ingot: '铁锭', diamond: '钻石', wheat: '小麦', wheat_seeds: '小麦种子',
        cooked_porkchop: '熟猪排', porkchop: '生猪排', cooked_beef: '牛排', beef: '生牛肉', bread: '面包', apple: '苹果',
        shield: '盾牌', bow: '弓', arrow: '箭', water_bucket: '水桶', bucket: '桶',
    };
    const id = String(value || '');
    if (names[id]) return `${names[id]}（${id}）`;
    const woods = { oak: '橡木', spruce: '云杉', birch: '白桦', jungle: '丛林木', acacia: '金合欢', dark_oak: '深色橡木', mangrove: '红树', cherry: '樱花木' };
    for (const [wood, name] of Object.entries(woods)) {
        if (id === `${wood}_log`) return `${name}原木（${id}）`;
        if (id === `${wood}_planks`) return `${name}木板（${id}）`;
        if (id === `${wood}_sapling`) return `${name}树苗（${id}）`;
    }
    const tool = id.match(/^(wooden|stone|iron|golden|diamond|netherite)_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/);
    if (tool) {
        const materials = { wooden: '木', stone: '石', iron: '铁', golden: '金', diamond: '钻石', netherite: '下界合金' };
        const kinds = { sword: '剑', pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子' };
        return `${materials[tool[1]]}${kinds[tool[2]]}（${id}）`;
    }
    return id;
}
