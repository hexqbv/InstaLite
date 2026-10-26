require("dotenv").config();

const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });
const app = express();

app.use(express.json());

const PORT = 3000;

const USER_SUMMARY = {
  id: true,
  username: true,
  fullname: true,
};

const POST_DETAILS = {
  author: { select: USER_SUMMARY },
  _count: { select: { likes: true } },
};

function validId(value) {
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function pagination(query) {
  const pageText = query.page ?? "1";
  const limitText = query.limit ?? "10";

  if (
    !/^[1-9]\d*$/.test(String(pageText)) ||
    !/^[1-9]\d*$/.test(String(limitText))
  ) {
    return { error: "page and limit must be positive integers" };
  }

  const page = Number(pageText);
  const limit = Math.min(Number(limitText), 50);

  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(limit) ||
    page < 1 ||
    limit < 1 ||
    !Number.isSafeInteger((page - 1) * limit)
  ) {
    return { error: "page and limit must be positive integers" };
  }

  return { page, limit, skip: (page - 1) * limit };
}

function meta(page, limit, total) {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

function error500(res, error) {
  console.error(error);
  return res.status(500).json({ error: "Internal server error" });
}

function isValidDate(value) {
  if (!value || typeof value !== "string") return false;
  return !Number.isNaN(Date.parse(value));
}

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

app.post("/users", async (req, res) => {
  const { username, email, fullname, bio } = req.body ?? {};

  if (!username || !email || !fullname) {
    return res.status(400).json({
      error: "username, email and fullname are required",
    });
  }

  try {
    const user = await prisma.user.create({
      data: {
        username,
        email,
        fullname,
        ...(bio !== undefined ? { bio } : {}),
      },
    });

    return res.status(201).json(user);
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({
        error: "username or email already taken",
      });
    }
    return error500(res, error);
  }
});

app.get("/users", async (req, res) => {
  const p = pagination(req.query);
  if (p.error) return res.status(400).json({ error: p.error });

  const { page, limit, skip } = p;
  const sortBy = req.query.sortBy ?? "createdAt";
  const order = req.query.order ?? "desc";

  if (!["createdAt", "username", "fullname"].includes(sortBy)) {
    return res.status(400).json({
      error: "sortBy must be one of: createdAt, username, fullname",
    });
  }

  if (!["asc", "desc"].includes(order)) {
    return res.status(400).json({ error: "order must be asc or desc" });
  }

  const where = {};

  if (req.query.isPrivate !== undefined) {
    if (!["true", "false"].includes(req.query.isPrivate)) {
      return res.status(400).json({
        error: "isPrivate must be true or false",
      });
    }
    where.isPrivate = req.query.isPrivate === "true";
  }

  if (req.query.hasPosts !== undefined) {
    if (!["true", "false"].includes(req.query.hasPosts)) {
      return res.status(400).json({
        error: "hasPosts must be true or false",
      });
    }

    where.posts = req.query.hasPosts === "true"
      ? { some: {} }
      : { none: {} };
  }

  if (req.query.search) {
    where.OR = [
      { username: { contains: req.query.search, mode: "insensitive" } },
      { fullname: { contains: req.query.search, mode: "insensitive" } },
    ];
  }

  try {
    const [data, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: order },
        include: {
          _count: { select: { posts: true, likes: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    return res.status(200).json({
      data,
      meta: meta(page, limit, total),
    });
  } catch (error) {
    return error500(res, error);
  }
});

app.get("/users/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "User not found" });

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        _count: { select: { posts: true, likes: true } },
      },
    });

    if (!user) return res.status(404).json({ error: "User not found" });
    return res.status(200).json(user);
  } catch (error) {
    return error500(res, error);
  }
});

app.patch("/users/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "User not found" });

  const body = req.body ?? {};
  const data = {};

  for (const field of ["fullname", "bio", "isPrivate"]) {
    if (Object.hasOwn(body, field)) data[field] = body[field];
  }

  if (
    Object.hasOwn(data, "isPrivate") &&
    typeof data.isPrivate !== "boolean"
  ) {
    return res.status(400).json({
      error: "isPrivate must be true or false",
    });
  }

  try {
    const user = await prisma.user.update({ where: { id }, data });
    return res.status(200).json(user);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    return error500(res, error);
  }
});

app.delete("/users/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "User not found" });

  try {
    await prisma.user.delete({ where: { id } });
    return res.status(204).end();
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "User not found" });
    }
    return error500(res, error);
  }
});

app.get("/users/:id/posts", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "User not found" });

  const p = pagination(req.query);
  if (p.error) return res.status(400).json({ error: p.error });

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    const where = { authorId: id };

    const [data, total] = await prisma.$transaction([
      prisma.post.findMany({
        where,
        skip: p.skip,
        take: p.limit,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { likes: true } } },
      }),
      prisma.post.count({ where }),
    ]);

    return res.status(200).json({
      data,
      meta: meta(p.page, p.limit, total),
    });
  } catch (error) {
    return error500(res, error);
  }
});

app.get("/users/:id/liked-posts", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "User not found" });

  const p = pagination(req.query);
  if (p.error) return res.status(400).json({ error: p.error });

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    const where = { likes: { some: { userId: id } } };

    const [data, total] = await prisma.$transaction([
      prisma.post.findMany({
        where,
        skip: p.skip,
        take: p.limit,
        orderBy: { createdAt: "desc" },
        include: POST_DETAILS,
      }),
      prisma.post.count({ where }),
    ]);

    return res.status(200).json({
      data,
      meta: meta(p.page, p.limit, total),
    });
  } catch (error) {
    return error500(res, error);
  }
});

app.post("/posts", async (req, res) => {
  const { imageUrl, authorId, caption, location } = req.body ?? {};

  if (
    imageUrl === undefined ||
    imageUrl === null ||
    imageUrl === "" ||
    authorId === undefined ||
    authorId === null
  ) {
    return res.status(400).json({
      error: "imageUrl and authorId are required",
    });
  }

  if (!Number.isSafeInteger(authorId) || authorId < 1) {
    return res.status(404).json({ error: "User not found" });
  }

  try {
    const post = await prisma.post.create({
      data: {
        imageUrl,
        authorId,
        ...(caption !== undefined ? { caption } : {}),
        ...(location !== undefined ? { location } : {}),
      },
    });

    return res.status(201).json(post);
  } catch (error) {
    if (error.code === "P2003") {
      return res.status(404).json({ error: "User not found" });
    }
    return error500(res, error);
  }
});

app.get("/posts", async (req, res) => {
  const p = pagination(req.query);
  if (p.error) return res.status(400).json({ error: p.error });

  const { page, limit, skip } = p;
  const sortBy = req.query.sortBy ?? "createdAt";
  const order = req.query.order ?? "desc";

  if (!["createdAt", "updatedAt", "likes"].includes(sortBy)) {
    return res.status(400).json({
      error: "sortBy must be one of: createdAt, updatedAt, likes",
    });
  }

  if (!["asc", "desc"].includes(order)) {
    return res.status(400).json({ error: "order must be asc or desc" });
  }

  const where = {};

  if (req.query.location !== undefined) {
    where.location = {
      equals: req.query.location,
      mode: "insensitive",
    };
  }

  if (req.query.search) {
    where.caption = {
      contains: req.query.search,
      mode: "insensitive",
    };
  }

  if (req.query.from !== undefined || req.query.to !== undefined) {
    if (
      (req.query.from !== undefined && !isValidDate(req.query.from)) ||
      (req.query.to !== undefined && !isValidDate(req.query.to))
    ) {
      return res.status(400).json({
        error: "from and to must be valid dates",
      });
    }

    where.createdAt = {};

    if (req.query.from !== undefined) {
      where.createdAt.gte = new Date(req.query.from);
    }

    if (req.query.to !== undefined) {
      where.createdAt.lt = new Date(req.query.to);
    }
  }

  const orderBy = sortBy === "likes"
    ? [{ likes: { _count: order } }, { createdAt: "desc" }]
    : { [sortBy]: order };

  try {
    const [data, total] = await prisma.$transaction([
      prisma.post.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: POST_DETAILS,
      }),
      prisma.post.count({ where }),
    ]);

    return res.status(200).json({
      data,
      meta: meta(page, limit, total),
    });
  } catch (error) {
    return error500(res, error);
  }
});

app.get("/posts/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "Post not found" });

  try {
    const post = await prisma.post.findUnique({
      where: { id },
      include: POST_DETAILS,
    });

    if (!post) return res.status(404).json({ error: "Post not found" });
    return res.status(200).json(post);
  } catch (error) {
    return error500(res, error);
  }
});

app.patch("/posts/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "Post not found" });

  const body = req.body ?? {};
  const data = {};

  for (const field of ["caption", "location"]) {
    if (Object.hasOwn(body, field)) data[field] = body[field];
  }

  try {
    const post = await prisma.post.update({ where: { id }, data });
    return res.status(200).json(post);
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Post not found" });
    }
    return error500(res, error);
  }
});

app.delete("/posts/:id", async (req, res) => {
  const id = validId(req.params.id);
  if (id === null) return res.status(404).json({ error: "Post not found" });

  try {
    await prisma.post.delete({ where: { id } });
    return res.status(204).end();
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Post not found" });
    }
    return error500(res, error);
  }
});

app.get("/posts/:id/likes", async (req, res) => {
  const postId = validId(req.params.id);
  if (postId === null) {
    return res.status(404).json({ error: "Post not found" });
  }

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });

    if (!post) return res.status(404).json({ error: "Post not found" });

    const likes = await prisma.like.findMany({
      where: { postId },
      orderBy: { user: { username: "asc" } },
      select: { user: { select: USER_SUMMARY } },
    });

    return res.status(200).json(likes.map((like) => like.user));
  } catch (error) {
    return error500(res, error);
  }
});

app.post("/posts/:id/likes", async (req, res) => {
  const postId = validId(req.params.id);
  const { userId } = req.body ?? {};

  if (userId === undefined || userId === null) {
    return res.status(400).json({ error: "userId is required" });
  }

  if (postId === null) {
    return res.status(404).json({ error: "Post not found" });
  }

  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(404).json({ error: "User not found" });
  }

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });

    if (!post) return res.status(404).json({ error: "Post not found" });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    const like = await prisma.like.create({
      data: { userId, postId },
    });

    return res.status(201).json(like);
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ error: "Already liked" });
    }
    if (error.code === "P2003") {
      return res.status(404).json({ error: "User not found" });
    }
    return error500(res, error);
  }
});

app.delete("/posts/:id/likes/:userId", async (req, res) => {
  const postId = validId(req.params.id);
  const userId = validId(req.params.userId);

  if (postId === null || userId === null) {
    return res.status(404).json({ error: "Like not found" });
  }

  try {
    await prisma.like.delete({
      where: { userId_postId: { userId, postId } },
    });

    return res.status(204).end();
  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({ error: "Like not found" });
    }
    return error500(res, error);
  }
});

async function startServer() {
  try {
    await prisma.$connect();

    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}

startServer();
