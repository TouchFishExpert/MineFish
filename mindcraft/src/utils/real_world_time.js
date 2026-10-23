const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

// Sample when the explicit time query executes; no automatic prompt injection.
export function getRealWorldTime(now = new Date()) {
    const p = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
    return 'Current real-world date and time: '
        + `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute}:${p.second} (Asia/Shanghai, UTC+08:00).`;
}
