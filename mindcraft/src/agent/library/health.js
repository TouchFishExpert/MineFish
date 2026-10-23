// Read the synchronized server attribute instead of assuming ten vanilla hearts.
export function getMaxHealth(bot) {
    const attribute = Object.entries(bot.entity?.attributes || {}).find(([key]) =>
        String(key).replace(/^minecraft:/, '').replace(/^generic\./, '') === 'max_health')?.[1];
    if (!Number.isFinite(attribute?.value)) return 20;
    const modifiers = attribute.modifiers || [];
    let base = attribute.value;
    for (const mod of modifiers) if (mod.operation === 0 || mod.operation === 'add_value') base += mod.amount;
    let value = base;
    for (const mod of modifiers) if (mod.operation === 1 || mod.operation === 'add_multiplied_base') value += base * mod.amount;
    for (const mod of modifiers) if (mod.operation === 2 || mod.operation === 'add_multiplied_total') value *= 1 + mod.amount;
    return Number.isFinite(value) && value > 0 ? value : 20;
}
