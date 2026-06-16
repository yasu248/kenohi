export interface OrderItem {
  name: string;
  price: number;
  sweetness: string;
  ice: string;
  quantity: number;
}

export interface Order {
  id: string;
  items: OrderItem[];
  totalPrice: number;
  customerName: string;
  customerAvatar?: string;
  status: 'pending' | 'preparing' | 'completed' | 'cancelled';
  createdAt: string;
  orderNumber: string;
}

const STORAGE_KEY = 'milktea_orders_mock';

// Generate a random 4-digit order number
function generateOrderNumber(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Get all orders from localStorage
export function getOrders(): Order[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch (e) {
    return [];
  }
}

// Save all orders to localStorage and dispatch a storage event manually
// so that the current tab also receives the event if it's listening.
function saveOrders(orders: Order[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  // Dispatch custom event for the same tab
  window.dispatchEvent(new Event('mock-db-update'));
}

// Add a new order
export function addOrder(items: OrderItem[], customerName: string, customerAvatar?: string): Order {
  const orders = getOrders();
  const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  
  const newOrder: Order = {
    id: Math.random().toString(36).substring(2, 11),
    items,
    totalPrice,
    customerName,
    customerAvatar,
    status: 'pending',
    createdAt: new Date().toISOString(),
    orderNumber: generateOrderNumber(),
  };

  orders.push(newOrder);
  saveOrders(orders);
  return newOrder;
}

// Update order status
export function updateOrderStatus(orderId: string, status: Order['status']): void {
  const orders = getOrders();
  const index = orders.findIndex(o => o.id === orderId);
  if (index !== -1) {
    orders[index].status = status;
    saveOrders(orders);
  }
}

// Subscribe to orders in real-time (across tabs and within the same tab)
export function subscribeOrders(callback: (orders: Order[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  // Initial call
  callback(getOrders());

  // Listen to storage changes from other tabs
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      callback(getOrders());
    }
  };

  // Listen to changes from the same tab
  const handleLocalChange = () => {
    callback(getOrders());
  };

  window.addEventListener('storage', handleStorageChange);
  window.addEventListener('mock-db-update', handleLocalChange);

  // Return unsubscribe function
  return () => {
    window.removeEventListener('storage', handleStorageChange);
    window.removeEventListener('mock-db-update', handleLocalChange);
  };
}
