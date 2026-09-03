"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { GestureReader, pressWasClick } from "./bot-gestures";
import { BotPersona, ShaziSprite } from "./bot-personas";
import { ShaziCursorVomit, type CursorOffset } from "./shazi-cursor-vomit";
import { ShaziFlipGame } from "./shazi-flip-game";

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
/** Headroom the speech cloud needs above the bot before it flips underneath. */
const CLOUD_HEADROOM = 48;
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
  /**
   * Source of the persona-switch roll. Injectable so a test can pin it —
   * a 17% chance is otherwise untestable without running the click hundreds
   * of times and hoping.
   */
  random?: () => number;
};

/** How often clicking robo turns it into 啥子. */
export const SHAZI_SWITCH_CHANCE = 0.17;

/**
 * Where 啥子's "退出" opens. A fixed value from the easter-egg table, not a URL
 * from any tool result. Opened in a new tab with noopener/noreferrer so a run
 * in progress on this page is never thrown away, and so the opened page gets
 * no handle back to this one.
 */
export const SHAZI_QUIT_LINK =
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1";

/** Click 啥子 this many times to start the flip game. */
export const CLICK_COUNT_FLIP_GAME = 7;
/** No re-trigger for this long after the flip game runs. */
export const FLIP_GAME_COOLDOWN_MS = 20 * 60_000;
/** Three clicks make 啥子 swallow and return the pointer. */
export const CLICK_COUNT_CURSOR_VOMIT = 3;
/** No re-trigger for this long after the cursor-vomit egg runs. */
export const CURSOR_VOMIT_COOLDOWN_MS = 60_000;
/** What every cooling-down egg shows, in the speech cloud. */
export const COOLDOWN_LINE = "少年的脸红胜过一切💗";

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

export function WanderBot({ lookAt = null, perchSelector, boundsSelector, obstructed = false, speechPlace = null, random = Math.random }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef<Point | null>(null);
  const draggingRef = useRef(false);
  const launchFrameRef = useRef(0);

  const [settled, setSettled] = useState(false);
  const [dragging, setDragging] = useState(false);
  /**
   * Session-only on purpose: a reload always comes back as robo, so nobody can
   * end up stuck as 啥子 with no idea how they got there. The 17% surprise is
   * worth having precisely because it is a chance encounter.
   */
  const [persona, setPersona] = useState<BotPersona>("robo");
  /** 啥子's right-click menu. A lone right-click opens it; "退出" leaves. */
  const [quitMenuOpen, setQuitMenuOpen] = useState(false);
  /** The seven-click flip game is running. */
  const [flipGameOpen, setFlipGameOpen] = useState(false);
  /** A one-shot line in the speech cloud, e.g. the cooldown message. */
  const [flashLine, setFlashLine] = useState<string | null>(null);
  const flashTimerRef = useRef(0);
  // When the flip game last ran, to hold its cooldown. -Infinity, not 0:
  // performance.now() starts near zero, so 0 would read as "just played" and
  // keep the game in cooldown from the very first trigger.
  const flipPlayedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const cursorVomitPlayedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const latestPointerRef = useRef<Point | null>(null);
  const [cursorVomitTarget, setCursorVomitTarget] = useState<CursorOffset | null>(null);
  /** Gestures only 啥子 answers; robo settles its single click immediately. */
  const gesturesRef = useRef(new GestureReader());
  const gestureTimerRef = useRef(0);
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const pumpRef = useRef<() => void>(() => {});
  const [perched, setPerched] = useState(false);
  const [cloudBelow, setCloudBelow] = useState(false);

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

  const refreshCloudSide = useCallback(() => {
    const node = rootRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setCloudBelow(box.top - bounds().top < CLOUD_HEADROOM);
  }, [bounds]);

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
      // Perch and cloud side both depend on where it came to rest, not on
      // where it was dropped.
      refreshPerched();
      refreshCloudSide();
    }, GLIDE_MS);
  }, [refreshCloudSide, refreshPerched, settlePosition]);

  // Opening position: sitting at the composer's top-left corner, mirroring it
  // rather than landing on the status chips that sit directly above it.
  useEffect(() => {
    const rememberPointer = (event: PointerEvent) => {
      latestPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", rememberPointer, { passive: true });
    return () => window.removeEventListener("pointermove", rememberPointer);
  }, []);

  const startCursorVomit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const pointer = latestPointerRef.current ?? {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
    };
    // The mouth in the source artwork is centred at roughly 54% / 54%.
    setCursorVomitTarget({
      x: pointer.x - (box.left + box.width * 0.54),
      y: pointer.y - (box.top + box.height * 0.54),
    });
  }, []);

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
      refreshCloudSide();
    };

    // The composer mounts with the page, so retry once on the next frame if it
    // is not measurable yet.
    place();
    const retry = window.requestAnimationFrame(place);
    return () => window.cancelAnimationFrame(retry);
  }, [bounds, perchRect, refreshCloudSide, refreshPerched, settlePosition]);

  useEffect(() => {
    if (speechPlace) refreshCloudSide();
  }, [refreshCloudSide, speechPlace]);

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

  /** Shows a one-shot line in the speech cloud, cleared after a beat. */
  const flashCloud = useCallback((line: string) => {
    window.clearTimeout(flashTimerRef.current);
    setFlashLine(line);
    flashTimerRef.current = window.setTimeout(() => setFlashLine(null), 2600);
  }, []);
  useEffect(() => () => window.clearTimeout(flashTimerRef.current), []);

  /** Ends the flip game: rights the screen and opens its cooldown. */
  const onFlipGameExit = useCallback(() => {
    flipPlayedAtRef.current = performance.now();
    setFlipGameOpen(false);
  }, []);

  /**
   * One click on the bot. robo settles immediately; 啥子 buffers into a run.
   *
   * robo can settle now because it has exactly one gesture. Dropping the old
   * ten-click trigger is what made that safe — with nothing else counting
   * clicks on robo, an immediate roll can never cut a run short.
   */
  const onBotClick = useCallback((at: number) => {
    if (persona === "robo") {
      if (random() < SHAZI_SWITCH_CHANCE) setPersona("shazi");
      return;
    }
    gesturesRef.current.leftClick(at);
    pumpRef.current();
  }, [persona, random]);

  /**
   * Right-click belongs to 啥子. It opens a menu rather than acting, which is
   * what lets the reader hold it for a moment to see whether a second click
   * follows: a harmless, reversible menu can afford the wait, and without it
   * the double-click could never be reached.
   */
  const onContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (persona !== "shazi") return;
    event.preventDefault();
    // performance.now(), not event.timeStamp: the pump measures its windows on
    // the performance clock, and a synthetic event's timeStamp can be a
    // different origin or NaN, which quietly breaks the pairing math.
    gesturesRef.current.rightClick(performance.now());
    pumpRef.current();
  }, [persona]);

  /** Dragging: the bot stays wherever it is dropped. */
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const node = rootRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const grabOffset = { x: event.clientX - box.left, y: event.clientY - box.top };

    node.setPointerCapture(event.pointerId);
    pressRef.current = { x: event.clientX, y: event.clientY, at: performance.now() };
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

    const onUp = (upEvent: PointerEvent) => {
      draggingRef.current = false;
      setDragging(false);
      const dropped = positionRef.current;
      if (dropped) settleWithGlide(dropped);
      const press = pressRef.current;
      pressRef.current = null;
      if (press && pressWasClick({
        movedPx: Math.hypot(upEvent.clientX - press.x, upEvent.clientY - press.y),
        heldMs: performance.now() - press.at,
      })) {
        onBotClick(performance.now());
      }
      node.releasePointerCapture?.(event.pointerId);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };

    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
  }, [applyPosition, bounds, onBotClick, settleWithGlide]);

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
  /*
   * One timer for every pending gesture, rearmed after each drain. A run of
   * clicks resolves only once the traveller stops clicking, so nothing here
   * polls — the reader says when the next window closes.
   */
  useEffect(() => {
    pumpRef.current = () => {
      window.clearTimeout(gestureTimerRef.current);
      const due = gesturesRef.current.nextDueAt();
      if (due === null) return;
      gestureTimerRef.current = window.setTimeout(() => {
        for (const gesture of gesturesRef.current.drain(performance.now())) {
          // A lone right-click raises the menu; a double takes 啥子 back to
          // robo. The rest of the eggs plug in here as they are specified; an
          // unhandled gesture is deliberately a no-op rather than a guess.
          if (gesture.kind === "rightClick") setQuitMenuOpen(true);
          if (gesture.kind === "rightDoubleClick") setPersona("robo");
          if (gesture.kind === "clickRun" && gesture.count === CLICK_COUNT_CURSOR_VOMIT) {
            if (performance.now() - cursorVomitPlayedAtRef.current < CURSOR_VOMIT_COOLDOWN_MS) {
              flashCloud(COOLDOWN_LINE);
            } else {
              cursorVomitPlayedAtRef.current = performance.now();
              startCursorVomit();
            }
          }
          if (gesture.kind === "clickRun" && gesture.count === CLICK_COUNT_FLIP_GAME) {
            // Cooldown: within the window, the egg holds and 啥子 just blushes
            // instead — every cooling egg shows the same line.
            if (performance.now() - flipPlayedAtRef.current < FLIP_GAME_COOLDOWN_MS) {
              flashCloud(COOLDOWN_LINE);
            } else {
              setFlipGameOpen(true);
            }
          }
        }
        pumpRef.current();
      }, Math.max(0, due - performance.now()));
    };
    return () => window.clearTimeout(gestureTimerRef.current);
  }, [flashCloud, startCursorVomit]);

  /* A persona change abandons whatever run was in flight: the clicks were
   * aimed at the character that just left. The menu belongs to 啥子, so it
   * closes with the change too. */
  useEffect(() => {
    gesturesRef.current.reset();
    window.clearTimeout(gestureTimerRef.current);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuitMenuOpen(false);
  }, [persona]);

  useEffect(() => {
    const onResize = () => {
      const node = rootRef.current;
      const point = positionRef.current;
      if (!node || !point) return;
      settlePosition(point);
      refreshPerched();
      refreshCloudSide();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [refreshCloudSide, refreshPerched, settlePosition]);

  /*
   * The menu is dismissable: a press anywhere outside it closes it, so a
   * right-click that was a mistake costs nothing. Escape closes it too, the
   * same escape hatch the full-screen eggs will use.
   */
  useEffect(() => {
    if (!quitMenuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setQuitMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuitMenuOpen(false);
    };
    // Next tick: the same press that opened the menu must not close it.
    const arm = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(arm);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [quitMenuOpen]);

  /** Leaves for the easter-egg link in a new tab, then closes the menu. */
  const onQuit = useCallback(() => {
    setQuitMenuOpen(false);
    window.open(SHAZI_QUIT_LINK, "_blank", "noopener,noreferrer");
  }, []);

  const finishCursorVomit = useCallback(() => setCursorVomitTarget(null), []);

  return (
    <>
    <div
      ref={rootRef}
      className="wanderly-bot"
      data-pose={perched ? "perched" : "idle"}
      data-dragging={dragging ? "true" : "false"}
      data-settled={settled ? "true" : "false"}
      data-cloud={cloudBelow ? "below" : "above"}
      data-effect={cursorVomitTarget ? "cursor-vomit" : undefined}
      data-game={flipGameOpen ? "flip" : undefined}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      data-persona={persona}
      role="presentation"
      style={{
        // Exposed as variables so the CSS keeps the golden-ratio relationships.
        "--bot-w": `${BODY_WIDTH}px`,
        "--bot-h": `${BODY_HEIGHT}px`,
        "--bot-leg": `${LEG_LENGTH}px`,
      } as React.CSSProperties}
    >
      {flashLine ? (
        <div className="wanderly-bot-cloud">
          <span>{flashLine}</span>
        </div>
      ) : speechPlace ? (
        <div className="wanderly-bot-cloud">
          <span>{speechPlace}…?</span>
        </div>
      ) : null}

      {persona === "shazi" && quitMenuOpen ? (
        <div
          ref={menuRef}
          className="wanderly-bot-quit-menu"
          // Inside the bot's own box, whose pointerdown starts a drag. Stop it
          // so pressing the menu picks the item instead of dragging 啥子.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={onQuit}>退出</button>
        </div>
      ) : null}

      {persona === "shazi" ? (
        <div ref={bodyRef} className="wanderly-bot-body wanderly-bot-body--sprite">
          <ShaziSprite onMissing={() => setPersona("robo")} />
          {cursorVomitTarget ? (
            <ShaziCursorVomit
              cursor={cursorVomitTarget}
              onComplete={finishCursorVomit}
            />
          ) : null}
        </div>
      ) : (
        <>
          <div ref={bodyRef} className="wanderly-bot-body">
            <span className="wanderly-bot-eye" />
            <span className="wanderly-bot-eye" />
          </div>

          <div className="wanderly-bot-legs">
            <span className="wanderly-bot-leg" />
            <span className="wanderly-bot-leg" />
          </div>
        </>
      )}
    </div>
    {/* Portalled to the body so the full-screen flip is not caught inside the
        bot's own transformed, fixed-positioned box. */}
    {persona === "shazi" && flipGameOpen && typeof document !== "undefined"
      ? createPortal(<ShaziFlipGame onExit={onFlipGameExit} />, document.body)
      : null}
    </>
  );
}
