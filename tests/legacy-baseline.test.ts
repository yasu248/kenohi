import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTestDatabase, type MockOrderRow } from './helpers/inMemoryDb.ts';

/**
 * Step B: 既存システムの現状動作（Legacy Behavior）を再現・検証するベースラインテストスイート
 *
 * ※本番DBには一切接続せず、InMemoryTestDatabase 上で既存ロジックの挙動と潜在課題を検証します。
 */

describe('[Legacy Baseline] 既存システムの動作再現テスト', () => {
  let db: InMemoryTestDatabase;

  beforeEach(() => {
    db = new InMemoryTestDatabase({ migrationApplied: false, deterministicStartNumber: 3100 });
  });

  it('1. 注文作成と商品オプションの保持: OrderItem.name にオプション文字列が連結され、status=unpaid で登録されること', () => {
    const items = [
      {
        name: 'ほうじ茶ミルクティー (ゼリー: あり, 甘さ: 控えめ, 氷: 氷なし)',
        price: 400,
        quantity: 2,
      },
      {
        name: '釜炒り緑茶 (ゼリー: なし, 甘さ: なし, 氷: 氷あり)',
        price: 250,
        quantity: 1,
      },
    ];

    const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const row: MockOrderRow = {
      id: 'order_legacy_1',
      items,
      total_price: totalPrice,
      customer_name: 'しぶ茶ちゃん',
      customer_avatar: 'https://example.com/avatar.png',
      status: 'unpaid',
      order_number: '3100',
      created_at: '2026-11-08T02:00:00.000Z',
    };
    db.orders.set(row.id, row);

    const saved = db.orders.get('order_legacy_1')!;
    assert.equal(saved.total_price, 1050);
    assert.equal(saved.status, 'unpaid');
    // キッチン画面(getOrderCups)のパース方式 `item.name.split(' (')` との互換性検証
    const nameParts = saved.items[0].name.split(' (');
    assert.equal(nameParts[0], 'ほうじ茶ミルクティー');
    assert.equal('(' + nameParts[1], '(ゼリー: あり, 甘さ: 控えめ, 氷: 氷なし)');
  });

  it('2. 注文一覧取得: status=unpaid および status=cancelled、STORE_STATE_001 が除外されること', () => {
    db.orders.set('STORE_STATE_001', {
      id: 'STORE_STATE_001',
      items: [],
      total_price: 0,
      customer_name: 'STORE_STATE',
      customer_avatar: JSON.stringify({ isManualOpen: true, date: '2026-11-08' }),
      status: 'cancelled',
      order_number: '0000',
      created_at: '2026-11-08T01:00:00.000Z',
    });
    db.orders.set('o_unpaid', {
      id: 'o_unpaid',
      items: [{ name: '緑茶', price: 250, quantity: 1 }],
      total_price: 250,
      customer_name: '未決済顧客',
      customer_avatar: null,
      status: 'unpaid',
      order_number: '3101',
      created_at: '2026-11-08T01:01:00.000Z',
    });
    db.orders.set('o_pending', {
      id: 'o_pending',
      items: [{ name: '青茶ミルクティー', price: 400, quantity: 1 }],
      total_price: 400,
      customer_name: '決済済顧客',
      customer_avatar: null,
      status: 'pending',
      order_number: '3102',
      created_at: '2026-11-08T01:02:00.000Z',
    });

    // 既存 getOrders() 相当のフィルタ
    const activeOrders = Array.from(db.orders.values()).filter(
      (r) => r.status !== 'cancelled' && r.status !== 'unpaid'
    );

    assert.equal(activeOrders.length, 1);
    assert.equal(activeOrders[0].id, 'o_pending');
  });

  it('3. [既存の課題再現] 旧決済確認では、調理中(preparing)の注文に対して遅れてWebhookが届くと pending に巻き戻るリスクがあること', () => {
    db.orders.set('o_cooking', {
      id: 'o_cooking',
      items: [{ name: '緑茶ミルクティー', price: 400, quantity: 1 }],
      total_price: 400,
      customer_name: '顧客A',
      customer_avatar: null,
      status: 'preparing', // すでにキッチンで調理開始済み
      order_number: '3103',
      created_at: '2026-11-08T01:05:00.000Z',
    });

    // 旧実装: 無条件に updateOrderStatus(orderId, 'pending') を呼んでいた
    const legacyConfirmUpdate = (orderId: string) => {
      const target = db.orders.get(orderId);
      if (target) target.status = 'pending';
    };

    legacyConfirmUpdate('o_cooking');
    assert.equal(db.orders.get('o_cooking')!.status, 'pending', '旧実装ではpreparingがpendingに巻き戻ってしまう');
  });

  it('4. [既存の課題再現] 旧ステータス設計では、受渡完了も注文取消も status=cancelled になり、売上集計で区別できないこと', () => {
    // キッチンで受渡完了(閉じる)にした注文
    db.orders.set('o_handed_over', {
      id: 'o_handed_over',
      items: [{ name: 'ほうじ茶', price: 250, quantity: 1 }],
      total_price: 250,
      customer_name: '受渡完了顧客',
      customer_avatar: null,
      status: 'cancelled',
      order_number: '3104',
      created_at: '2026-11-08T01:10:00.000Z',
    });

    // 本当にキャンセルされた注文（旧スキーマでは同じ status='cancelled'）
    db.orders.set('o_real_cancel', {
      id: 'o_real_cancel',
      items: [{ name: '青茶ミルクティー', price: 400, quantity: 2 }],
      total_price: 800,
      customer_name: 'キャンセル顧客',
      customer_avatar: null,
      status: 'cancelled',
      order_number: '3105',
      created_at: '2026-11-08T01:12:00.000Z',
    });

    // 旧 history API のフィルタ: id !== 'STORE_STATE_001' && status !== 'unpaid'
    const historyRows = Array.from(db.orders.values()).filter(
      (r) => r.id !== 'STORE_STATE_001' && r.status !== 'unpaid'
    );
    const legacyRevenue = historyRows.reduce((sum, r) => sum + r.total_price, 0);

    // 旧実装では本当のキャンセル分(800円)も合算され 1050円 になってしまう
    assert.equal(legacyRevenue, 1050);
  });
});
