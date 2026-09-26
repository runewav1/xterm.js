/**
 * Copyright (c) 2020 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { assert } from 'chai';
import { OptionsService, DEFAULT_OPTIONS } from './OptionsService';
import { IDisposable } from '../Types';

describe('OptionsService', () => {
  describe('constructor', () => {
    const originalError = console.error;
    beforeEach(() => {
      console.error = () => { };
    });
    afterEach(() => {
      console.error = originalError;
    });
    it('uses default value if invalid constructor option values passed for cols/rows', () => {
      const optionsService = new OptionsService({ cols: undefined, rows: undefined });
      assert.equal(optionsService.options.rows, DEFAULT_OPTIONS.rows);
      assert.equal(optionsService.options.cols, DEFAULT_OPTIONS.cols);
    });
    it('uses values from constructor option values if correctly passed', () => {
      const optionsService = new OptionsService({ cols: 80, rows: 25 });
      assert.equal(optionsService.options.rows, 25);
      assert.equal(optionsService.options.cols, 80);
    });
    it('uses default value if invalid constructor option value passed', () => {
      assert.equal(new OptionsService({ tabStopWidth: 0 }).options.tabStopWidth, DEFAULT_OPTIONS.tabStopWidth);
    });
    it('object.keys return the correct number of options', () => {
      const optionsService = new OptionsService({ cols: 80, rows: 25 });
      assert.notEqual(Object.keys(optionsService.options).length, 0);
    });
  });
  describe('setOption', () => {
    let service: OptionsService;
    beforeEach(() => {
      service = new OptionsService({});
    });
    it('applies valid fontWeight option values', () => {
      service.options.fontWeight = 'bold';
      assert.equal(service.options.fontWeight, 'bold', '"bold" keyword value should be applied');

      service.options.fontWeight = 'normal';
      assert.equal(service.options.fontWeight, 'normal', '"normal" keyword value should be applied');

      service.options.fontWeight = '600';
      assert.equal(service.options.fontWeight, '600', 'String numeric values should be applied');

      service.options.fontWeight = 350;
      assert.equal(service.options.fontWeight, 350, 'Values between 1 and 1000 should be applied as is');

      service.options.fontWeight = 1;
      assert.equal(service.options.fontWeight, 1, 'Range should include minimum value: 1');

      service.options.fontWeight = 1000;
      assert.equal(service.options.fontWeight, 1000, 'Range should include maximum value: 1000');
    });
    it('normalizes invalid fontWeight option values', () => {
      service.options.fontWeight = 350;
      assert.doesNotThrow(() => service.options.fontWeight = 10000, 'fontWeight should be normalized instead of throwing');
      assert.equal(service.options.fontWeight, DEFAULT_OPTIONS.fontWeight, 'Values greater than 1000 should be reset to default');

      service.options.fontWeight = 350;
      service.options.fontWeight = -10;
      assert.equal(service.options.fontWeight, DEFAULT_OPTIONS.fontWeight, 'Values less than 1 should be reset to default');

      service.options.fontWeight = 350;
      service.options.fontWeight = 'bold700' as any;
      assert.equal(service.options.fontWeight, DEFAULT_OPTIONS.fontWeight, 'Wrong string literals should be reset to default');
    });
  });
  describe('cursorTrail', () => {
    it('resolves disabled defaults', () => {
      const service = new OptionsService({});
      assert.equal(service.options.cursorTrail, 0);
      assert.deepEqual(service.options.cursorTrailDecay, [0.1, 0.4]);
      assert.deepEqual(service.options.cursorTrailStartThreshold, [2, 2] as [number, number]);
      assert.equal(service.options.cursorTrailColor, 'none');
    });
    it('normalizes numeric values without an arbitrary cap', () => {
      const service = new OptionsService({});
      service.options.cursorTrail = 999999.9;
      assert.equal(service.options.cursorTrail, 999999);
      service.options.cursorTrail = -5;
      assert.equal(service.options.cursorTrail, 0);
      service.options.cursorTrailDecay = [0.4, 0.1];
      assert.deepEqual(service.options.cursorTrailDecay, [0.4, 0.4]);
      // An explicit zero is allowed and means "snap instantly".
      service.options.cursorTrailDecay = [0, 0];
      assert.deepEqual(service.options.cursorTrailDecay, [0, 0]);
      service.options.cursorTrailStartThreshold = 5;
      assert.deepEqual(service.options.cursorTrailStartThreshold as number | [number, number], [5, 5]);
      service.options.cursorTrailStartThreshold = [1, 3];
      assert.deepEqual(service.options.cursorTrailStartThreshold as number | [number, number], [1, 3]);
    });
    it('coerces non-finite numbers sensibly', () => {
      const service = new OptionsService({});
      service.options.cursorTrail = NaN;
      assert.equal(service.options.cursorTrail, 0);
      service.options.cursorTrailDecay = [NaN, Infinity];
      assert.deepEqual(service.options.cursorTrailDecay, [0.1, 0.4]);
      service.options.cursorTrailStartThreshold = [NaN, Infinity];
      assert.deepEqual(service.options.cursorTrailStartThreshold, [2, 2] as [number, number]);
    });
    it('rejects an invalid color and accepts none', () => {
      const service = new OptionsService({});
      assert.throws(() => service.options.cursorTrailColor = 'not-a-color', 'color');
      service.options.cursorTrailColor = '#ff0000';
      assert.equal(service.options.cursorTrailColor, '#ff0000');
      service.options.cursorTrailColor = 'none';
      assert.equal(service.options.cursorTrailColor, 'none');
    });
    it('does not share default arrays across instances', () => {
      const a = new OptionsService({});
      const b = new OptionsService({});
      assert.notStrictEqual(a.options.cursorTrailDecay, b.options.cursorTrailDecay);
      assert.notStrictEqual(a.options.cursorTrailStartThreshold, b.options.cursorTrailStartThreshold);
      a.options.cursorTrailDecay[0] = 9;
      assert.equal(b.options.cursorTrailDecay[0], 0.1);
      assert.equal(DEFAULT_OPTIONS.cursorTrailDecay[0], 0.1);
    });
    it('fires the option change event on reassignment', async () => {
      const service = new OptionsService({});
      await new Promise<void>(r => {
        service.onSpecificOptionChange('cursorTrail', value => {
          assert.equal(value, 25);
          r();
        });
        service.options.cursorTrail = 25;
      });
    });
  });

  describe('onOptionChange', () => {
    let service: OptionsService;
    beforeEach(() => {
      service = new OptionsService({});
    });
    it('should fire on any option change', async () => {
      let disposable: IDisposable;
      await new Promise<void>(r => {
        disposable = service.onOptionChange(e => {
          assert.strictEqual(e, 'cursorWidth');
          r();
        });
        service.options.cursorWidth = 10;
      });
      disposable!.dispose();
      await new Promise<void>(r => {
        service.onOptionChange(e => {
          assert.strictEqual(e, 'scrollback');
          r();
        });
        service.options.scrollback = 20;
      });
    });
  });
  describe('onSpecificOptionChange', () => {
    let service: OptionsService;
    beforeEach(() => {
      service = new OptionsService({});
    });
    it('should fire only on a specific option change', async () => {
      await new Promise<void>(r => {
        service.onSpecificOptionChange('scrollback', e => {
          assert.strictEqual(e, 20);
          r();
        });
        service.options.cursorWidth = 10;
        service.options.scrollback = 20;
      });
    });
  });
  describe('onSpecificOptionChange', () => {
    let service: OptionsService;
    beforeEach(() => {
      service = new OptionsService({});
    });
    it('should fire only on a specific option change', async () => {
      await new Promise<void>(r => {
        service.onSpecificOptionChange('scrollback', e => {
          assert.strictEqual(e, 20);
          r();
        });
        service.options.cursorWidth = 10;
        service.options.scrollback = 20;
      });
    });
  });
  describe('onMultipleOptionChange', () => {
    let service: OptionsService;
    beforeEach(() => {
      service = new OptionsService({});
    });
    it('should fire only for specific options', async () => {
      await new Promise<void>(r => {
        let called = false;
        service.onMultipleOptionChange(['scrollback'], () => {
          called = true;
        });
        service.options.cursorWidth = 10;
        assert.notOk(called);
        service.options.scrollback = 20;
        assert.ok(called);
        r();
      });
    });
  });
});
