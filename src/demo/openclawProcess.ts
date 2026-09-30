import { spawn } from 'node:child_process';
import { z } from 'zod';

const MAX_OUTPUT = 128 * 1024;
/** Runs inside the owned container. EOF is cancellation, not just client exit.
 * SIGTERM reaches OpenClaw's CLI signal bridge, which aborts its gateway run.
 * A forced kill is reported as uncertain; it can never produce an answer. */
export const OPENCLAW_SUPERVISOR = `
import { spawn } from 'node:child_process';
let buffer='', child, timer, hard, cancelled=false, forced=false, closed=false, length=0;
const chunks=[];
const stop=()=>{cancelled=true;if(child&&!closed){child.kill('SIGTERM');hard??=setTimeout(()=>{forced=true;child.kill('SIGKILL');},10000);}};
process.stdin.setEncoding('utf8');process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
process.stdin.on('data',(text)=>{
 if(child)return;
 buffer+=text;if(Buffer.byteLength(buffer)>24576){process.exitCode=1;process.stdin.destroy();return;}
 const end=buffer.indexOf('\\n');if(end<0)return;
 let packet;try{packet=JSON.parse(buffer.slice(0,end));if(typeof packet.prompt!=='string'||!Number.isInteger(packet.deadlineMs)||packet.deadlineMs<50||packet.deadlineMs>75000)throw 0;}catch{process.exitCode=1;process.stdin.destroy();return;}
 if(cancelled){process.exitCode=1;process.stdin.destroy();return;}
 const [exe,...args]=process.argv.slice(1);
 child=spawn(exe,[...args,packet.prompt],{stdio:['ignore','pipe','pipe']});
 buffer='';timer=setTimeout(stop,packet.deadlineMs);
 child.stdout.on('data',(chunk)=>{length+=chunk.length;if(length>131072)stop();else chunks.push(chunk);});
 child.stderr.on('data',()=>{});
 child.on('error',()=>{cancelled=true;});
 child.on('close',(code)=>{closed=true;clearTimeout(timer);clearTimeout(hard);process.stdin.destroy();
  process.stdout.end(JSON.stringify({code,stdout:cancelled?'':Buffer.concat(chunks).toString('utf8'),cancelled,forced}));});
});
`;
const packetSchema = z.strictObject({ code: z.number().int().nullable(), stdout: z.string(), cancelled: z.boolean(), forced: z.boolean() });

/** Host-side transport. Only public fictional request inputs cross stdin.
 * Never forwards provider stderr, credentials, arbitrary host environment or
 * an exec error containing argv. No shell interpolation and no automatic retry. */
export async function runSupervisedProcess(options: { executable: string; args: string[]; prompt: string;
  signal: AbortSignal; deadlineMs: number }): Promise<string> {
  options.signal.throwIfAborted();
  if (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 50 || options.deadlineMs > 75000 ||
      !options.prompt.isWellFormed() || Buffer.byteLength(options.prompt) > 16 * 1024) throw new Error('OpenClaw input unavailable');
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let length = 0, failed = false; const chunks: Buffer[] = [];
    const cancel = () => { failed = true; child.stdin.end(); };
    const timer = setTimeout(cancel, options.deadlineMs);
    // The remote supervisor gets time to signal/settle the CLI. A broken Docker
    // connection cannot establish remote cleanup, so its bounded exit is failure.
    const hard = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, options.deadlineMs + 15000);
    options.signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > MAX_OUTPUT + 8192) cancel(); else chunks.push(chunk); });
    child.stderr.on('data', () => {}); child.stdin.on('error', cancel); child.on('error', () => { failed = true; });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(hard); options.signal.removeEventListener('abort', cancel);
      try {
        if (failed || code !== 0 || options.signal.aborted) throw new Error();
        const packet = packetSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (packet.code !== 0 || packet.cancelled || packet.forced || Buffer.byteLength(packet.stdout) > MAX_OUTPUT) throw new Error();
        resolve(packet.stdout);
      } catch { reject(new Error(options.signal.aborted ? 'OpenClaw run cancelled; no answer accepted' : 'OpenClaw run unavailable; no answer accepted')); }
      finally { chunks.forEach((chunk) => chunk.fill(0)); }
    });
    child.stdin.write(JSON.stringify({ prompt: options.prompt, deadlineMs: options.deadlineMs }) + '\n');
    if (options.signal.aborted) cancel();
  });
}
