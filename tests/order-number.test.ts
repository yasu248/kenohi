import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateAtomicOrderNumber,
  MigrationRequiredError,
  OrderNumberLimitExceededError,
  getJSTDateString,
  resolveInheritedOrderNumber,
} from '../src/lib/orderNumber.ts';
import { InMemoryTestDatabase } from './helpers/inMemoryDb.ts';

describe('[Phase 0-E / 監査修正 A] 注文番号の原子的採番・引き継ぎ・上限・日付変更テスト', () => {
  let db: InMemoryTestDatabase;

  beforeEach(() => {
    db = new InMemoryTestDatabase({ migrationApplied: true, deterministicStartNumber: null });
  });

  const createDbRpcCaller = (targetDb: InMemoryTestDatabase) => {
    return async (fnName: string, args: { p_store_id: string; p_order_date: string }) => {
      assert.equal(fnName, 'next_order_number');
      try {
        const result = targetDb.rpcNextOrderNumber(args.p_store_id, args.p_order_date);
        return { data: result, error: null };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { data: null, error: { code: 'P0001', message } };
      }
    };
  };

  it('1. JST 日付文字列の生成: 日本時間の YYYY-MM-DD が正しく取得できること', () => {
    // 2026-11-08 15:00:00 UTC = 2026-11-09 00:00:00 JST
    const date = new Date('2026-11-08T15:00:00.000Z');
    assert.equal(getJSTDateString(date), '2026-11-09');
  });

  it('2. 既存注文番号と STORE_STATE_001 の整合性確認と引き継ぎ (resolveInheritedOrderNumber)', () => {
    // ケースA: orders と STORE_STATE_001 が一致している場合
    const aligned = resolveInheritedOrderNumber({
      orderDate: '2026-11-08',
      existingOrderNumbersForDate: ['3101', '3102', '3105'],
      storeState: { currentOrderDate: '2026-11-08', lastOrderNumber: 3105 },
    });
    assert.equal(aligned.maxFromOrders, 3105);
    assert.equal(aligned.lastFromStoreState, 3105);
    assert.equal(aligned.hasDiscrepancy, false);
    assert.equal(aligned.inheritedLastNumber, 3105);

    // ケースB: STORE_STATE_001 の方が大きい場合 (注文レコード保存前に採番だけ進んでいたケース)
    const stateAhead = resolveInheritedOrderNumber({
      orderDate: '2026-11-08',
      existingOrderNumbersForDate: ['3101', '3105'],
      storeState: { currentOrderDate: '2026-11-08', lastOrderNumber: 3108 },
    });
    assert.equal(stateAhead.hasDiscrepancy, true);
    assert.equal(stateAhead.inheritedLastNumber, 3108);

    // ケースC: orders テーブルの最大値の方が大きい場合 (STORE_STATE_001 が別操作で巻き戻っていたケース)
    const ordersAhead = resolveInheritedOrderNumber({
      orderDate: '2026-11-08',
      existingOrderNumbersForDate: ['3101', '3112'],
      storeState: { currentOrderDate: '2026-11-08', lastOrderNumber: 3104 },
    });
    assert.equal(ordersAhead.hasDiscrepancy, true);
    assert.equal(ordersAhead.inheritedLastNumber, 3112);

    // ケースD: STORE_STATE_001 の日付が前日の場合、当日の引き継ぎ対象外とすること
    const yesterdayState = resolveInheritedOrderNumber({
      orderDate: '2026-11-09',
      existingOrderNumbersForDate: [],
      storeState: { currentOrderDate: '2026-11-08', lastOrderNumber: 4890 },
    });
    assert.equal(yesterdayState.inheritedLastNumber, 0);
  });

  it('3. 旧採番から新採番への切り替え: 当日の既存注文および STORE_STATE_001 から重複なく +1 で引き継ぐこと', async () => {
    const testDate = new Date('2026-11-08T03:00:00.000Z'); // 2026-11-08 12:00 JST

    // 旧コードで 3420, 3421 が作成され、STORE_STATE_001 に 3422 が記録されている状態を再現
    db.orders.set('ord_legacy_1', {
      id: 'ord_legacy_1',
      items: [{ name: '焙じ茶ミルクティー', price: 650, quantity: 1 }],
      total_price: 650,
      customer_name: '山田',
      customer_avatar: null,
      status: 'completed',
      order_number: '3420',
      created_at: '2026-11-08T02:00:00.000Z',
    });
    db.orders.set('ord_legacy_2', {
      id: 'ord_legacy_2',
      items: [{ name: '煎茶ミルクティー', price: 650, quantity: 1 }],
      total_price: 650,
      customer_name: '佐藤',
      customer_avatar: null,
      status: 'pending',
      order_number: '3421',
      created_at: '2026-11-08T02:30:00.000Z',
    });
    db.orders.set('STORE_STATE_001', {
      id: 'STORE_STATE_001',
      items: [],
      total_price: 0,
      customer_name: 'STORE_STATE',
      customer_avatar: JSON.stringify({
        isManualOpen: false,
        date: '2026-11-08',
        currentOrderDate: '2026-11-08',
        lastOrderNumber: 3422,
      }),
      status: 'cancelled',
      order_number: '0000',
      created_at: '2026-11-08T01:00:00.000Z',
    });

    const rpcCaller = createDbRpcCaller(db);

    // 切り替え後の最初の注文番号は GREATEST(3421, 3422) + 1 = 3423 になること
    const next1 = await allocateAtomicOrderNumber({ rpcCaller, date: testDate });
    assert.equal(next1, '3423');

    // 続く注文は 3424, 3425 と連続採番されること
    const next2 = await allocateAtomicOrderNumber({ rpcCaller, date: testDate });
    assert.equal(next2, '3424');
    const next3 = await allocateAtomicOrderNumber({ rpcCaller, date: testDate });
    assert.equal(next3, '3425');
  });

  it('4. 連続採番と同時注文採番: Promise.all による50件同時リクエストでも重複が一切発生しないこと', async () => {
    db.deterministicStartNumber = 3501;
    const testDate = new Date('2026-11-08T04:00:00.000Z');
    const rpcCaller = createDbRpcCaller(db);

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        allocateAtomicOrderNumber({ rpcCaller, date: testDate })
      )
    );

    const uniqueNumbers = new Set(results);
    assert.equal(uniqueNumbers.size, 50, '50件すべての注文番号が一意であること');
    assert.equal(results[0], '3501');
    assert.equal(results[49], '3550');
  });

  it('5. 4桁番号の上限 (9999) と翌日の初期化検証: 9999超過時はエラー停止し、翌日は 3000〜5000 で再開すること', async () => {
    const day1 = new Date('2026-11-08T05:00:00.000Z'); // 2026-11-08 JST
    const day2 = new Date('2026-11-09T05:00:00.000Z'); // 2026-11-09 JST

    // 当日すでに 9998 まで採番されている状態を作る
    db.orders.set('ord_near_limit', {
      id: 'ord_near_limit',
      items: [],
      total_price: 500,
      customer_name: '上限テスト',
      customer_avatar: null,
      status: 'pending',
      order_number: '9998',
      created_at: '2026-11-08T04:50:00.000Z',
    });

    const rpcCaller = createDbRpcCaller(db);

    // 9999 は正常に採番できること
    const num9999 = await allocateAtomicOrderNumber({ rpcCaller, date: day1 });
    assert.equal(num9999, '9999');

    // 次の 10000 (5桁) は OrderNumberLimitExceededError で拒否されること
    await assert.rejects(
      async () => {
        await allocateAtomicOrderNumber({ rpcCaller, date: day1 });
      },
      (err: unknown) => {
        assert.ok(err instanceof OrderNumberLimitExceededError);
        assert.equal(err.code, 'ORDER_NUMBER_LIMIT_EXCEEDED');
        return true;
      }
    );

    // 翌日 (2026-11-09) になると 3000〜5000 の範囲で新しく初期化されること
    const nextDayFirst = await allocateAtomicOrderNumber({ rpcCaller, date: day2 });
    const parsedNextDay = Number.parseInt(nextDayFirst, 10);
    assert.ok(
      parsedNextDay >= 3000 && parsedNextDay <= 5000,
      `翌日の初回番号 (${parsedNextDay}) が 3000〜5000 の範囲内であること`
    );

    const nextDaySecond = await allocateAtomicOrderNumber({ rpcCaller, date: day2 });
    assert.equal(Number.parseInt(nextDaySecond, 10), parsedNextDay + 1);
  });

  it('6. マイグレーション未適用時の安全停止: RPC未定義エラー時に MigrationRequiredError を送出すること', async () => {
    const unmigratedDb = new InMemoryTestDatabase({ migrationApplied: false });
    const rpcCaller = async (fnName: string, args: { p_store_id: string; p_order_date: string }) => {
      try {
        const data = unmigratedDb.rpcNextOrderNumber(args.p_store_id, args.p_order_date);
        return { data, error: null };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { data: null, error: { code: 'PGRST202', message } };
      }
    };

    await assert.rejects(
      async () => {
        await allocateAtomicOrderNumber({ rpcCaller });
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
