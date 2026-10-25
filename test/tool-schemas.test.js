// The tool list, pinned so that a changed name, description or input schema
// is a visible diff in the fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listTools } from '../dist/tools.js';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/tool-schemas.json', import.meta.url), 'utf8'));

test('every tool is listed with the name, description and input schema the fixture records', () => {
    const tools = listTools();
    assert.equal(tools.length, FIXTURE.length, `listed ${tools.length} tools, the fixture records ${FIXTURE.length}`);
    assert.deepStrictEqual(tools, FIXTURE);
});
