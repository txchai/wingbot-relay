// Count actual executions, retaining real D1 behavior (including atomic batches).
export function observeD1(db: D1Database, afterAll?: (query: string) => Promise<void>) {
  const counts = { calls: 0, statements: 0, pauseReads: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement, query: string): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, method) {
        if (method === "bind") return (...values: unknown[]) => wrap(target.bind(...values), query);
        if (["run", "all", "first", "raw"].includes(String(method))) {
          return async (...args: unknown[]) => {
            counts.calls++;
            counts.statements++;
            if (/SELECT 1 FROM settings WHERE key IN/.test(query)) counts.pauseReads++;
            const result = await Reflect.get(target, method, target).apply(target, args);
            if (method === "all") await afterAll?.(query);
            return result;
          };
        }
        const value = Reflect.get(target, method, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  }
  const DB = new Proxy(db, {
    get(target, method) {
      if (method === "prepare") return (query: string) => wrap(target.prepare(query), query);
      if (method === "batch") return (statements: D1PreparedStatement[]) => {
        counts.calls++;
        counts.statements += statements.length;
        return target.batch(statements.map(statement => originals.get(statement) ?? statement));
      };
      const value = Reflect.get(target, method, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { DB, counts };
}
