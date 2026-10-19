// Entrada interactiva: texto visible y contraseña sin eco
import { createInterface } from 'node:readline/promises';
export async function promptLine(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try {
        return (await rl.question(question)).trim();
    }
    finally {
        rl.close();
    }
}
export async function confirm(question) {
    const a = (await promptLine(question)).toLowerCase();
    return a === 's' || a === 'si' || a === 'sí' || a === 'y' || a === 'yes';
}
/** Lee una contraseña sin mostrarla. Requiere una terminal interactiva. */
export function promptHidden(question) {
    const stdin = process.stdin;
    if (!stdin.isTTY)
        return Promise.reject(new Error('Hace falta una terminal interactiva para pedir la contraseña'));
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return new Promise((resolve, reject) => {
        let buf = '';
        const done = () => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write('\n');
        };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') {
                    done();
                    resolve(buf);
                    return;
                }
                if (ch === '\u0003') {
                    done();
                    reject(new Error('Cancelado'));
                    return;
                } // Ctrl+C
                if (ch === '\u0015') {
                    buf = '';
                    continue;
                } // Ctrl+U
                if (ch === '\u007f' || ch === '\b') {
                    buf = buf.slice(0, -1);
                    continue;
                }
                if (ch >= ' ')
                    buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}
