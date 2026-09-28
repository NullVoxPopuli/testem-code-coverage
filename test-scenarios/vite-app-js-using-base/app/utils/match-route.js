import RouteRecognizer from 'route-recognizer';

/**
 * Exercises a third-party dependency whose published source map lists bare
 * relative `sources` ("route-recognizer/dsl.ts", …). Those resolve against the
 * app bundle's own directory, so without filtering they leak into the coverage
 * report as files that live nowhere. See issue #34.
 */
export function matchRoute(path) {
  const router = new RouteRecognizer();

  router.add([{ path: '/scores/:id', handler: 'score' }]);

  const results = router.recognize(path);

  return results ? results[0].params.id : null;
}
