import { ProductCard, type Product } from "./ProductCard";

export function ProductGrid({ items }: { items: Product[] }) {
  return (
    <section className="grid" data-testid="product-grid">
      {items.map((item) => (
        <ProductCard key={item.id} product={item} />
      ))}
    </section>
  );
}
