import { Suspense } from "react";

import { ExploreMapPage } from "@/components/explore/explore-map-page";

export default function HomePage() {
  // ExploreMapPage reads the camera hand-off from the query string via
  // useSearchParams, which Next cannot resolve while statically prerendering.
  // The boundary lets the shell prerender and the params resolve on the client.
  return (
    <Suspense fallback={null}>
      <ExploreMapPage />
    </Suspense>
  );
}
