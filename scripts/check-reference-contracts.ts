import { compileReferenceContracts } from '../src/demo/contracts.js';

const { provenance } = compileReferenceContracts();
process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
