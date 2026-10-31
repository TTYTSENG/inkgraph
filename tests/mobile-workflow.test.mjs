import test from 'node:test';
import assert from 'node:assert/strict';
import {captureWorkflow} from '../public/mobile-model.js';

test('Reception stays saved when only part of a mixed capture fails recognition',()=>{
  const result=captureWorkflow({mediaCount:2,sourceIds:['audio','photo']},[{source_id:'audio',state:'done'},{source_id:'photo',state:'failed'}]);
  assert.equal(result.phase,'attention');assert.equal(result.counts.done,1);assert.equal(result.counts.failed,1);
  assert.match(result.label,/1 份需處理.*1 份已產生文字/);assert.equal(result.received,'電腦已保存此版本');assert.match(result.review,/尚未登記/);
});
test('A retry with a retained old transcript is processing, not already complete',()=>{
  const result=captureWorkflow({mediaCount:1,sourceIds:['audio']},[{source_id:'audio',state:'queued'},{source_id:'audio',state:'done'}]);
  assert.equal(result.phase,'processing');assert.equal(result.counts.done,0);assert.equal(result.counts.queued,1);
});
test('Unloaded or removed attachment jobs cannot imply that a capture is complete',()=>{
  assert.equal(captureWorkflow({mediaCount:2,sourceIds:['one']},[{source_id:'one',state:'done'}]).phase,'unavailable');
  assert.equal(captureWorkflow({mediaCount:1,sourceIds:[]},[]).counts.unavailable,1);
  assert.equal(captureWorkflow({mediaCount:0,sourceIds:[]},[]).phase,'text');
});
test('A finished machine job is pending human review and unrelated sources do not count',()=>{
  const result=captureWorkflow({mediaCount:1,sourceIds:['one']},[{source_id:'other',state:'failed'},{source_id:'one',state:'done'}]);
  assert.equal(result.phase,'review');assert.equal(result.counts.failed,0);assert.match(result.label,/待人工核對/);
});
