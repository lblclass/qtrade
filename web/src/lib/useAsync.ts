import { useCallback, useEffect, useRef, useState } from "react";

type AsyncState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  refreshToken = 0,
): AsyncState<T> {
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => {
        if (active) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshToken, tick]);

  return { data, error, loading, reload };
}