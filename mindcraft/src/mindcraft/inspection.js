// A bounded read, without sending chat, waking the model, or changing the bot's task.
import { validateMemoryEdit } from '../agent/memory_edit.js';
export function requestAgentInspection(connection, timeoutMs = 3000) {
    if (!connection) return Promise.resolve({ error: 'not-found' });
    if (!connection.in_game || !connection.socket?.connected) return Promise.resolve({ error: 'offline' });
    return new Promise(resolve => {
        connection.socket.timeout(timeoutMs).emit('get-inspection', (error, snapshot) => {
            if (error) resolve({ error: 'timeout' });
            else if (!snapshot) resolve({ error: 'unavailable' });
            else resolve({ snapshot });
        });
    });
}

export function requestAgentMemoryUpdate(connection, request, timeoutMs = 3000) {
    const error = validateMemoryEdit(request);
    if (error) return Promise.resolve({ error });
    if (!connection) return Promise.resolve({ error: 'not-found' });
    if (!connection.in_game || !connection.socket?.connected) return Promise.resolve({ error: 'offline' });
    return new Promise(resolve => {
        connection.socket.timeout(timeoutMs).emit('update-memory', request, (error, response) => {
            if (error) resolve({ error: 'timeout' });
            else resolve(response || { error: 'unavailable' });
        });
    });
}
