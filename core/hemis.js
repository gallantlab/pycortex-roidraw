// The two hemisphere keys every per-hemisphere structure ({left, right}) is indexed by, in order.
export const HEMIS = ["left", "right"];

// Is `h` one of those keys? The one test for a hemisphere name read from a file or the host.
export const isHemi = (h) => HEMIS.includes(h);
