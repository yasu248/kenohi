import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateAtomicOrderNumber,
  MigrationRequiredError,
  getJSTDateString,
} from '../src/lib/orderNumber.ts';

describe('[Phase 0-E] 注文番号の原子的採番処理テスト', () => {
  it('1. JST 日付文字列の生成: 日本時間の YYYY-MM-DD が正しく取得できること', () => {
    // 2026-11-08 15:00:00 UTC = 2026-11-09 00:00:00 JST
    const date = new Date('2026-11-08T15:00:00.000Z');
    assert.equal(getJSTDateString(date), '2026-11-09');
  });

  it('2. 原子的採番 RPC の正常動作: PostgreSQL から返された番号が正しく返却されること', async () => {
    let mockSequence = 3500;
    const mockRpcCaller = async (fnName: string) => {
      assert.equal(fnName, 'next_order_number');
      mockSequence += 1;
      return { data: String(mockSequence), error: null };
    };

    const num1 = await allocateAtomicOrderNumber({ rpcCaller: mockRpcCaller });
    assert.equal(num1, '3501');

    const num2 = await allocateAtomicOrderNumber({ rpcCaller: mockRpcCaller });
    assert.equal(num2, '3502');
  });

  it('3. マイグレーション未適用時の安全停止: RPC未定義エラー時に MigrationRequiredError を送出すること', async () => {
    const mockUnmigratedRpcCaller = async () => {
      return {
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.next_order_number in the schema cache',
        },
      };
    };

    await assert.rejects(
      async () => {
        await allocateAtomicOrderNumber({ rpcCaller: mockUnmigratedRpcCaller });
      },
      (err: unknown) => {
        assert.ok(err instanceof MigrationRequiredError);
        assert.equal(err.code, 'MIGRATION_REQUIRED');
        assert.ok(err.message.includes('0001_phase0_foundation.sql'));
        return true;
      }
    );
  });
});
