// In-memory CRUD store backing the mock handlers. State lives for the
// lifetime of the process (node tests) or the tab (browser demo); call
// `reset()` between tests to isolate them.
export type Post = { id: number; title: string };

const SEED: Post[] = [
  { id: 1, title: "First post" },
  { id: 2, title: "Second post" },
];

let posts: Post[] = structuredClone(SEED);
let nextId = SEED.length + 1;

export const db = {
  list: (): Post[] => posts,

  create: (input: { title: string }): Post => {
    const post: Post = { id: nextId++, title: input.title };
    posts.push(post);
    return post;
  },

  update: (id: number, input: { title: string }): Post | undefined => {
    const post = posts.find((p) => p.id === id);
    if (!post) return undefined;
    post.title = input.title;
    return post;
  },

  remove: (id: number): boolean => {
    const before = posts.length;
    posts = posts.filter((p) => p.id !== id);
    return posts.length < before;
  },

  reset: (): void => {
    posts = structuredClone(SEED);
    nextId = SEED.length + 1;
  },
};
