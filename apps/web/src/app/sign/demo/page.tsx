'use client';

import { DemoRoom } from './demo-room';

/**
 * `/sign/demo` — the public signing-room demo, with the room itself in
 * `./demo-room.tsx`.
 *
 * The route only mounts the room, because a Next page module may export nothing
 * but the fields Next recognises: exporting the route transition or the document
 * page beside the page fails the production build with "is not a valid Page
 * export field", even though `tsc` is happy with it.
 */
export default function SignDemoPage() {
  return <DemoRoom />;
}
