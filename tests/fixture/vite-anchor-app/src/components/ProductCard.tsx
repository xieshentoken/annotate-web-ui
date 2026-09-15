/* Deliberately free of imports: the integration test runs Vite's real transform
 * pipeline, including import analysis, and an unresolvable bare specifier would
 * fail for reasons that have nothing to do with anchors.
 */

export interface Product {
  id: string;
  name: string;
  blurb: string;
  price: string;
  tag: string;
}

export function ProductCard({ product }: { product: Product }) {
  return (
    <article className="card" data-testid={`card-${product.id}`}>
      <span className="tag">{product.tag}</span>
      <h2>{product.name}</h2>
      <p>{product.blurb}</p>
      <div className="price">{product.price}</div>
      <div className="actions">
        <button className="primary">加入购物车</button>
        <button>详情</button>
      </div>
    </article>
  );
}
