"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Wander-bot: a small outlined companion that floats over the cosmic map.
 *
 * Proportions follow the golden ratio — the body is φ wider than it is tall,
 * and a full leg is the body height divided by φ. Everything else is derived
 * from BODY_HEIGHT so the character stays in proportion at any size.
 */
const PHI = 1.618;
const BODY_HEIGHT = 46;
const BODY_WIDTH = Math.round(BODY_HEIGHT * PHI);
const LEG_LENGTH = Math.round(BODY_HEIGHT / PHI);
const EYE_TRAVEL = 3;

/** How long the bot holds still, facing the globe, before it may look around. */
const SETTLE_MS = 3000;
/** How close the feet must land to the composer's top edge to count as sitting. */
const PERCH_TOLERANCE = 26;
const EDGE_MARGIN = 16;
/** Clearance kept between the bot's body and any panel it is avoiding. */
const AVOID_GAP = 2;
/** Bounded so a crowded corner can never spin the resolver. */
const AVOID_PASSES = 8;
/** Length of the ease into a clear spot after the bot is dropped. */
const GLIDE_MS = 260;
const LAUNCH_MS = 720;
const LAUNCH_ARC = 140;

type Point = { x: number; y: number };

type Props = {
  /** Where the bot should look, in viewport pixels. Usually the globe centre. */
  lookAt?: { x: number; y: number } | null;
  /** Selector for the chat composer the bot can sit on. */
  perchSelector?: string;
  /** Selector for the area the bot must stay inside. Defaults to the viewport. */
  boundsSelector?: string;
  /**
   * True once the chat panel expands over its corner. A bot standing in the
   * covered region is knocked clear rather than left buried under the panel.
   */
  obstructed?: boolean;
  /** Place name for the speech cloud, e.g. "上海". */
  speechPlace?: string | null;
};

type Bounds = { left: number; top: number; right: number; bottom: number };

function viewportBounds(): Bounds {
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/**
 * Keeps the bot inside its play area. The area is the map pane rather than the
 * whole window, so it can never be dropped — or knocked — underneath the
 * navigation rail that sits outside it.
 */
function clampToBounds(point: Point, width: number, height: number, bounds: Bounds): Point {
  const minX = bounds.left + EDGE_MARGIN;
  const minY = bounds.top + EDGE_MARGIN;
  return {
    x: Math.min(Math.max(point.x, minX), Math.max(minX, bounds.right - width - EDGE_MARGIN)),
    y: Math.min(Math.max(point.y, minY), Math.max(minY, bounds.bottom - height - EDGE_MARGIN)),
  };
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Nudges the bot until its *body* clears every panel on the map.
 *
 * Only the body counts — the legs are allowed to dangle over a panel, which is
 * what makes it read as sitting on the composer rather than hovering above it.
 *
 * Upward is tried first, so a bot dropped on a box ends up standing on top of
 * it. Only when there is no room above does it look for the nearest escape in
 * another direction.
 */
export function resolveAgainstObstacles(
  desired: Point,
  body: { dx: number; dy: number; width: number; height: number },
  obstacles: Bounds[],
  area: Bounds,
): Point {
  let point = clampToBounds(desired, body.width + body.dx, body.height + body.dy, area);

  for (let pass = 0; pass < AVOID_PASSES; pass += 1) {
    const rect: Bounds = {
      left: point.x + body.dx,
      top: point.y + body.dy,
      right: point.x + body.dx + body.width,
      bottom: point.y + body.dy + body.height,
    };
    const hit = obstacles.find((obstacle) => intersects(rect, obstacle));
    if (!hit) return point;

    const above = { x: point.x, y: hit.top - AVOID_GAP - body.height - body.dy };
    if (above.y >= area.top + EDGE_MARGIN) {
      point = above;
      continue;
    }

    // No headroom: take whichever remaining side needs the least travel.
    const candidates: Point[] = [
      { x: point.x, y: hit.bottom + AVOID_GAP - body.dy },
      { x: hit.left - AVOID_GAP - body.width - body.dx, y: point.y },
      { x: hit.right + AVOID_GAP - body.dx, y: point.y },
    ].filter((candidate) => (
      candidate.x + body.dx >= area.left + EDGE_MARGIN
      && candidate.x + body.dx + body.width <= area.right - EDGE_MARGIN
      && candidate.y + body.dy >= area.top + EDGE_MARGIN
      && candidate.y + body.dy + body.height <= area.bottom - EDGE_MARGIN
    ));

    if (candidates.length === 0) return point;
    candidates.sort((a, b) => (
      Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y)
    ));
    point = candidates[0];
  }

  return point;
}

export function WanderBot({ lookAt = null, perchSelector, boundsSelector, obstructed = false, speechPlace = null }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<Point | null>(null);
  const draggingRef = useRef(false);
  const launchFrameRef = useRef(0);

  const [settled, setSettled] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [perched, setPerched] = useState(false);

  // Position is written straight to style; keeping it in state would re-render
  // the subtree on every pointer move during a drag.
  const applyPosition = useCallback((point: Point) => {
    const node = rootRef.current;
    if (!node) return;
    positionRef.current = point;
    node.style.left = `${point.x}px`;
    node.style.top = `${point.y}px`;
  }, []);

  const bounds = useCallback((): Bounds => {
    if (!boundsSelector) return viewportBounds();
    const element = document.querySelector(boundsSelector);
    if (!element) return viewportBounds();
    const box = element.getBoundingClientRect();
    return box.width > 0 ? box : viewportBounds();
  }, [boundsSelector]);

  /** Body box relative to the root, plus its size. Legs are excluded. */
  const bodyMetrics = useCallback(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    if (!root || !body) return null;
    const rootBox = root.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    if (bodyBox.width === 0) return null;
    return {
      dx: bodyBox.left - rootBox.left,
      dy: bodyBox.top - rootBox.top,
      width: bodyBox.width,
      height: bodyBox.height,
    };
  }, []);

  const obstacleRects = useCallback((): Bounds[] => {
    const root = rootRef.current;
    return [...document.querySelectorAll("[data-wanderly-avoid]")]
      .filter((element) => !root?.contains(element))
      .map((element) => element.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
  }, []);

  /** Clamp to the play area, then lift the body clear of every panel. */
  const settlePosition = useCallback((desired: Point) => {
    const metrics = bodyMetrics();
    const area = bounds();
    if (!metrics) {
      applyPosition(clampToBounds(desired, BODY_WIDTH, BODY_HEIGHT, area));
      return;
    }
    applyPosition(resolveAgainstObstacles(desired, metrics, obstacleRects(), area));
  }, [applyPosition, bodyMetrics, bounds, obstacleRects]);

  const perchRect = useCallback(() => {
    if (!perchSelector) return null;
    const element = document.querySelector(perchSelector);
    return element ? element.getBoundingClientRect() : null;
  }, [perchSelector]);

  /** Legs only come out when the bot is actually sitting on the composer. */
  const refreshPerched = useCallback(() => {
    const node = rootRef.current;
    const perch = perchRect();
    if (!node || !perch) {
      setPerched(false);
      return;
    }
    const metrics = bodyMetrics();
    const box = node.getBoundingClientRect();
    const bodyBottom = metrics ? box.top + metrics.dy + metrics.height : box.bottom;
    const bodyLeft = metrics ? box.left + metrics.dx : box.left;
    const bodyRight = metrics ? bodyLeft + metrics.width : box.right;
    const overlapsHorizontally = bodyRight > perch.left && bodyLeft < perch.right;
    // Sitting means the body's bottom edge rests just above the bar's top edge.
    const seatedOnTop = Math.abs(bodyBottom - perch.top) < PERCH_TOLERANCE;
    setPerched(overlapsHorizontally && seatedOnTop);
  }, [bodyMetrics, perchRect]);

  /**
   * Moves to the resolved position with a short eased slide. The flag scopes
   * the CSS transition to this moment, so per-frame updates during a drag or
   * the launch arc still land immediately.
   */
  const settleWithGlide = useCallback((desired: Point) => {
    const node = rootRef.current;
    if (!node) return;
    node.dataset.settling = "true";
    settlePosition(desired);
    window.setTimeout(() => {
      if (rootRef.current) delete rootRef.current.dataset.settling;
      // Perch state depends on where it came to rest, not where it was dropped.
      refreshPerched();
    }, GLIDE_MS);
  }, [refreshPerched, settlePosition]);

  // Opening position: sitting at the composer's top-left corner, mirroring it
  // rather than landing on the status chips that sit directly above it.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || positionRef.current) return;

    const place = () => {
      const box = node.getBoundingClientRect();
      const height = box.height || BODY_HEIGHT + LEG_LENGTH;
      const perch = perchRect();
      // Seated on the bar: the body rests on its top edge and the legs dangle
      // over the front, rather than the whole bot floating above it.
      const area = bounds();
      const target = perch
        ? { x: perch.left, y: perch.top - AVOID_GAP - BODY_HEIGHT }
        : { x: area.left + EDGE_MARGIN, y: area.bottom - height - 140 };
      settlePosition(target);
      refreshPerched();
    };

    // The composer mounts with the page, so retry once on the next frame if it
    // is not measurable yet.
    place();
    const retry = window.requestAnimationFrame(place);
    return () => window.cancelAnimationFrame(retry);
  }, [bounds, perchRect, refreshPerched, settlePosition]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * Eye tracking writes CSS custom properties onto the element for the same
   * reason as the position: per-frame React state would re-render everything.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let target = lookAt;

    const apply = () => {
      frame = 0;
      const node = rootRef.current;
      if (!node) return;
      const box = node.getBoundingClientRect();
      if (box.width === 0) return;

      const originX = box.left + box.width / 2;
      const originY = box.top + box.height / 2;
      const point = target ?? { x: originX, y: originY };
      const dx = point.x - originX;
      const dy = point.y - originY;
      const distance = Math.hypot(dx, dy) || 1;

      node.style.setProperty("--bot-eye-x", `${(dx / distance) * EYE_TRAVEL}px`);
      node.style.setProperty("--bot-eye-y", `${(dy / distance) * EYE_TRAVEL}px`);
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(apply);
    };

    // Until it settles the bot keeps facing `lookAt` and ignores the pointer.
    const onPointerMove = (event: PointerEvent) => {
      if (!settled) return;
      target = { x: event.clientX, y: event.clientY };
      schedule();
    };

    schedule();
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [lookAt, settled]);

  /** Dragging: the bot stays wherever it is dropped. */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const node = rootRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const grabOffset = { x: event.clientX - box.left, y: event.clientY - box.top };

    node.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);

    const onMove = (moveEvent: PointerEvent) => {
      if (!draggingRef.current) return;
      // Follows the cursor exactly. Avoidance waits for the drop, so the bot
      // never flinches out from under the pointer mid-drag.
      applyPosition(clampToBounds(
        { x: moveEvent.clientX - grabOffset.x, y: moveEvent.clientY - grabOffset.y },
        box.width,
        box.height,
        bounds(),
      ));
    };

    const onUp = () => {
      draggingRef.current = false;
      setDragging(false);
      const dropped = positionRef.current;
      if (dropped) settleWithGlide(dropped);
      node.releasePointerCapture?.(event.pointerId);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };

    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
  }, [applyPosition, bounds, settleWithGlide]);

  /*
   * When the chat panel expands, a bot standing inside the region it covers is
   * launched to the bottom-left corner along a parabola, as though knocked
   * aside. A bot already clear of the panel is left where the user put it.
   */
  useEffect(() => {
    const node = rootRef.current;
    const from = positionRef.current;
    if (!obstructed || !node || !from || draggingRef.current) return;

    const box = node.getBoundingClientRect();
    const area = bounds();
    // The panel occupies the lower-right quadrant of the map pane; anything
    // overlapping that region gets moved out of the way.
    const coveredLeft = area.left + (area.right - area.left) * 0.5;
    const coveredTop = area.top + (area.bottom - area.top) * 0.35;
    if (box.right < coveredLeft || box.bottom < coveredTop) return;

    const to = clampToBounds(
      { x: area.left + EDGE_MARGIN, y: area.bottom - box.height - EDGE_MARGIN },
      box.width,
      box.height,
      area,
    );

    if (typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      applyPosition(to);
      return;
    }

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / LAUNCH_MS);
      // Linear travel plus an upward bulge: a simple parabolic arc.
      const arc = -LAUNCH_ARC * 4 * t * (1 - t);
      applyPosition({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t + arc,
      });
      if (t < 1) {
        launchFrameRef.current = window.requestAnimationFrame(step);
        return;
      }
      launchFrameRef.current = 0;
      settlePosition(to);
      refreshPerched();
    };

    launchFrameRef.current = window.requestAnimationFrame(step);
    return () => {
      if (launchFrameRef.current) window.cancelAnimationFrame(launchFrameRef.current);
      launchFrameRef.current = 0;
    };
  }, [applyPosition, bounds, obstructed, refreshPerched, settlePosition]);

  // Keep the bot on screen, and re-check its perch, when the window resizes.
  useEffect(() => {
    const onResize = () => {
      const node = rootRef.current;
      const point = positionRef.current;
      if (!node || !point) return;
      settlePosition(point);
      refreshPerched();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [refreshPerched, settlePosition]);

  return (
    <div
      ref={rootRef}
      className="wanderly-bot"
      data-pose={perched ? "perched" : "idle"}
      data-dragging={dragging ? "true" : "false"}
      data-settled={settled ? "true" : "false"}
      onPointerDown={onPointerDown}
      role="presentation"
      style={{
        // Exposed as variables so the CSS keeps the golden-ratio relationships.
        "--bot-w": `${BODY_WIDTH}px`,
        "--bot-h": `${BODY_HEIGHT}px`,
        "--bot-leg": `${LEG_LENGTH}px`,
      } as React.CSSProperties}
    >
      {speechPlace ? (
        <div className="wanderly-bot-cloud">
          <span>{speechPlace}…?</span>
        </div>
      ) : null}

      <div ref={bodyRef} className="wanderly-bot-body">
        <span className="wanderly-bot-eye" />
        <span className="wanderly-bot-eye" />
      </div>

      <div className="wanderly-bot-legs">
        <span className="wanderly-bot-leg" />
        <span className="wanderly-bot-leg" />
      </div>
    </div>
  );
}
