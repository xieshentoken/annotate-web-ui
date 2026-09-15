import { ProductGrid } from "./components/ProductGrid";

const items = [
  { id: "aurora", name: "极光耳机", blurb: "主动降噪，续航 40 小时", price: "¥1,299", tag: "现货" },
];

export function App() {
  return (
    <main className="app">
      <h1>在售产品</h1>
      <p className="sub">共 {items.length} 个 SKU</p>
      <ProductGrid items={items} />
    </main>
  );
}
