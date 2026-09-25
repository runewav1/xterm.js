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
  describe('cursorSmear', () => {
    it('resolves sensible defaults that are disabled', () => {
      const service = new OptionsService({});
      assert.deepEqual(service.options.cursorSmear, {
        enabled: false,
        duration: 120,
        style: 'trail',
        samples: 4,
        opacity: 0.5,
        color: undefined,
        easing: 'easeOut',
        minDistance: 1,
        maxDistance: 0,
        endScale: 1,
        respectReducedMotion: true
      });
    });
    it('clamps and normalizes numeric values', () => {
      const service = new OptionsService({});
      service.options.cursorSmear = {
        enabled: true,
        duration: 999999,
        samples: 999,
        opacity: -1,
        endScale: 2,
        minDistance: -5,
        maxDistance: 3
      };
      assert.equal(service.options.cursorSmear.duration, 5000);
      assert.equal(service.options.cursorSmear.samples, 16);
      assert.equal(service.options.cursorSmear.opacity, 0);
      assert.equal(service.options.cursorSmear.endScale, 1);
      assert.equal(service.options.cursorSmear.minDistance, 0);
      assert.equal(service.options.cursorSmear.maxDistance, 3);
    });
    it('lifts maxDistance to minDistance when inconsistent', () => {
      const service = new OptionsService({});
      service.options.cursorSmear = { minDistance: 5, maxDistance: 3 };
      assert.equal(service.options.cursorSmear.maxDistance, 5);
    });
    it('coerces non-finite numbers to defaults', () => {
      const service = new OptionsService({});
      service.options.cursorSmear = { duration: NaN, samples: Infinity, opacity: NaN, endScale: NaN };
      assert.equal(service.options.cursorSmear.duration, 120);
      assert.equal(service.options.cursorSmear.samples, 4);
      assert.equal(service.options.cursorSmear.opacity, 0.5);
      assert.equal(service.options.cursorSmear.endScale, 1);
    });
    it('rejects invalid enums and colors', () => {
      const service = new OptionsService({});
      assert.throws(() => service.options.cursorSmear = { style: 'comet' as any }, 'style');
      assert.throws(() => service.options.cursorSmear = { easing: 'bounce' as any }, 'easing');
      assert.throws(() => service.options.cursorSmear = { color: 'not-a-color' }, 'color');
    });
    it('does not share the default object across instances', () => {
      const a = new OptionsService({});
      const b = new OptionsService({});
      assert.notStrictEqual(a.options.cursorSmear, b.options.cursorSmear);
      a.options.cursorSmear.enabled = true;
      assert.equal(b.options.cursorSmear.enabled, false);
      assert.equal(DEFAULT_OPTIONS.cursorSmear.enabled, undefined);
    });
    it('fires the option change event on reassignment', async () => {
      const service = new OptionsService({});
      await new Promise<void>(r => {
        service.onSpecificOptionChange('cursorSmear', value => {
          assert.equal(value!.enabled, true);
          r();
        });
        service.options.cursorSmear = { enabled: true };
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
