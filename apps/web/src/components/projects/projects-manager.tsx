"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type UIEvent } from "react";
import { Link } from "@/i18n/navigation";
import { useOptionalAuth } from "@/lib/auth/auth-provider";
import { useTrips } from "@/lib/query/hooks";
import { readRecentTrip } from "@/lib/trips/recent-trip";
import styles from "./projects-manager.module.css";
import { NewTripButton } from "./new-trip-button";
import { WallCalendar } from "./wall-calendar";

const subscribe = () => () => {};
const colors = ["#aec1cb", "#c4cbc5", "#d4cbbd", "#9bafb9", "#c0c8d2"];
function recordColor(id: string) { return colors[Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % colors.length]; }

function useLoopingCollection(itemCount: number) {
  const collectionRef = useRef<HTMLDivElement>(null);
  const segmentRef = useRef<HTMLDivElement>(null);
  const previousSegmentWidth = useRef(0);

  useLayoutEffect(() => {
    const collection = collectionRef.current;
    const segment = segmentRef.current;
    if (!collection || !segment || itemCount === 0) return;

    const alignLoop = () => {
      const nextWidth = segment.offsetWidth;
      if (!nextWidth) return;
      const previousWidth = previousSegmentWidth.current;
      if (!previousWidth) {
        collection.scrollLeft = nextWidth;
      } else if (previousWidth !== nextWidth) {
        const localOffset = ((collection.scrollLeft - previousWidth) % previousWidth + previousWidth) % previousWidth;
        collection.scrollLeft = nextWidth + localOffset * nextWidth / previousWidth;
      }
      previousSegmentWidth.current = nextWidth;
    };

    alignLoop();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", alignLoop);
      return () => window.removeEventListener("resize", alignLoop);
    }
    const observer = new ResizeObserver(alignLoop);
    observer.observe(segment);
    return () => observer.disconnect();
  }, [itemCount]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const collection = event.currentTarget;
    const segmentWidth = segmentRef.current?.offsetWidth ?? 0;
    if (!segmentWidth) return;
    if (collection.scrollLeft < segmentWidth * 0.5) {
      collection.scrollLeft += segmentWidth;
    } else if (collection.scrollLeft > segmentWidth * 1.5) {
      collection.scrollLeft -= segmentWidth;
    }
  };

  return { collectionRef, segmentRef, onScroll };
}

export function ProjectsManager() {
  const t = useTranslations("recordRoom");
  const auth = useOptionalAuth();
  const viewer = auth?.status === "LOCAL_DEV" ? "local-dev" : auth?.status === "SIGNED_IN" ? auth.user?.username : null;
  const query = useTrips({ enabled: Boolean(viewer) });
  const recent = useSyncExternalStore(subscribe, () => viewer ? readRecentTrip(viewer) : null, () => null);
  const trips = viewer && query.isSuccess && !query.isError ? query.data.trips : [];
  const current = trips.find((trip) => trip.id === recent);
  const others = trips.filter((trip) => trip.id !== current?.id);
  const loop = useLoopingCollection(others.length);
  const recordSet = (copy: "before" | "main" | "after") => <div
    key={copy}
    ref={copy === "main" ? loop.segmentRef : undefined}
    className={styles.collectionSet}
    aria-hidden={copy === "main" ? undefined : true}
  >
    {others.map((trip) => <Link key={`${copy}-${trip.id}`} href={`/trips/${trip.id}` as "/trips/[tripId]"} className={styles.sleeve} aria-label={t("open", {name:trip.name})} title={trip.name} tabIndex={copy === "main" ? undefined : -1} style={{"--label":recordColor(trip.id)} as CSSProperties}>
      <span className={styles.album} aria-hidden="true">
        <span className={styles.vinyl}><span className={styles.recordLabel} /></span>
        <span className={styles.caseFace}><span className={styles.coverTitle}>{trip.name}</span><span className={styles.coverArt} /></span>
        <span className={styles.caseSpine}>{trip.name}</span>
      </span>
    </Link>)}
  </div>;
  return <main className={styles.room} aria-label={t("room")}>
    <div className={styles.scene}>
      <Image src="/images/gramophone-room-balanced-props.png" alt="" fill sizes="100vw" priority className={styles.background} />
      <Link href="/home" className={styles.globe} aria-label={t("exploreGlobe")} title={t("exploreGlobe")} />
      {current && <Link href={`/trips/${current.id}` as "/trips/[tripId]"} className={styles.platter} aria-label={t("open", {name: current.name})} title={current.name}>
        <span className={styles.rotatingRecord} style={{"--label":recordColor(current.id)} as CSSProperties}><span className={styles.recordLabel}>{current.name}</span></span>
      </Link>}
      {current && <span className={styles.nameplate}>{current.name}</span>}
    </div>
      {viewer && <NewTripButton />}
      <WallCalendar />
      <div ref={loop.collectionRef} className={styles.collection} aria-label={t("collection")} onScroll={loop.onScroll}>
        {recordSet("before")}{recordSet("main")}{recordSet("after")}
      </div>
      {!viewer && auth?.status !== "CHECKING" && <Link href="/login" className={styles.quietState}>{t("signIn")}</Link>}
      {viewer && query.isError && <button type="button" className={styles.quietState} onClick={() => void query.refetch()}>{t("retry")}</button>}
      {viewer && query.isSuccess && !trips.length && <Link href="/home" className={styles.quietState}>{t("empty")}</Link>}
      {(auth?.status === "CHECKING" || (viewer && query.isPending)) && <span role="status" className={styles.quietState}>{t("loading")}</span>}
  </main>;
}
