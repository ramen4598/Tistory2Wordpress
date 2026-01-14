import axios, { type AxiosError, type AxiosInstance } from 'axios';
import FormData from 'form-data';
import https from 'https';
import { loadConfig } from '../utils/config';
import { getLogger } from '../utils/logger';
import { retryWithBackoff } from '../utils/retry';
import { WpPostStatus } from '../enums/config.enum';

export interface CreatePostOptions {
  title: string;
  content: string;
  status: WpPostStatus;
  date: string;
  categories: number[];
  tags: number[];
  featuredImageId: number | null;
}

export interface CreatePostResult {
  id: number;
  status: string;
  link: string;
}

export interface UploadMediaOptions {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  altText?: string;
  title?: string;
}

export interface UploadMediaResult {
  id: number;
  url: string;
  mediaType: string;
  mimeType: string;
}

/**
 * Client for interacting with WordPress REST API.
 * Supports creating draft posts, uploading media, taxonomy helpers, and rollback.
 */
export interface WpClient {
  /**
   * Creates a draft post in WordPress.
   * @param options Options for creating the draft post.
   * @returns Result containing the ID, status, and link of the created post.
   */
  createPost(options: CreatePostOptions): Promise<CreatePostResult>;
  /**
   * Uploads media to WordPress.
   * @param options Options for uploading the media.
   * @returns Result containing the ID, URL, media type, and MIME type of the uploaded media.
   */
  uploadMedia(options: UploadMediaOptions): Promise<UploadMediaResult>;
  /**
   * Deletes media from WordPress.
   * @param mediaId The ID of the media to delete.
   * @throws Error if deletion fails.
   */
  deleteMedia(mediaId: number): Promise<void>;
  /**
   * Deletes a post from WordPress.
   * @param postId The ID of the post to delete.
   * @throws Error if deletion fails.
   */
  deletePost(postId: number): Promise<void>;
  /**
   * Ensures a category exists in WordPress, creating it if necessary.
   * @param name The name of the category.
   * @param parent Optional parent category ID.
   * @returns The ID of the ensured category.
   */
  ensureCategory(name: string, parent?: number): Promise<number>;
  /**
   * Ensures a tag exists in WordPress, creating it if necessary.
   * @param name The name of the tag.
   * @returns The ID of the ensured tag.
   */
  ensureTag(name: string): Promise<number>;
}

// function isRetryableStatus(status?: number): boolean {
//   if (!status) return false;
//   if (status === 429) return true;
//   if (status >= 500 && status < 600) return true;
//   return false;
// }

function getAxiosErrorMessage(error: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axiosError = error as AxiosError<any>;

  if (axiosError && axiosError.isAxiosError) {
    const status = axiosError.response?.status;
    const statusText = axiosError.response?.statusText;
    const message = axiosError.response?.data?.message;
    return `HTTP ${status ?? 'unknown'} ${statusText ?? ''} ${message ?? ''}`.trim();
  }

  return (error as Error)?.message ?? String(error);
}

function encodeHtmlEntity(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function createWpClient(): WpClient {
  const config = loadConfig();
  const logger = getLogger();

  // Remove trailing slash if any. e.g., https://example.com/ -> https://example.com
  const baseUrl = config.wpBaseUrl.replace(/\/$/, '');
  const apiBase = `${baseUrl}/wp-json/wp/v2`;

  const auth = Buffer.from(`${config.wpAppUser}:${config.wpAppPassword}`).toString('base64');

  const httpsAgent = new https.Agent({
    keepAlive: true,
    // 최대 유휴 연결 수. worker 수만큼은 항상 유지.
    maxFreeSockets: config.workerCount,
    rejectUnauthorized: true,
  });

  const client: AxiosInstance = axios.create({
    baseURL: apiBase,
    headers: {
      Authorization: `Basic ${auth}`,
    },
    timeout: 600000, // 10 minutes
    httpsAgent,
  });

  const categoryCache = new Map<string, number>(); // key: name value: categoryId
  const tagCache = new Map<string, number>(); // key: name value: tagId

  async function withRetry<T>(
    fn: () => Promise<T>,
    context: { operation: string; url: string }
  ): Promise<T> {
    return retryWithBackoff(fn, config, {
      onRetry: (error, attempt, delayMs) => {
        logger.warn(
          'WpClient.withRetry - retrying WordPress request',
          { operation: context.operation, url: context.url, attempt, delayMs },
          getAxiosErrorMessage(error)
        );
      },
    });
  }

  const createPost = async (options: CreatePostOptions): Promise<CreatePostResult> => {
    type WpPostPayload = {
      title: string;
      content: string;
      status: WpPostStatus;
      date: string;
      categories: number[];
      tags: number[];
      featured_media?: number;
    };

    const { title, content, status, date, categories, tags, featuredImageId } = options;
    const payload: WpPostPayload = {
      title,
      content,
      status,
      date,
      categories,
      tags,
    };

    if (featuredImageId) {
      payload.featured_media = featuredImageId;
    }

    logger.debug('WpClient.createPost - creating WordPress post', {
      title,
      status,
      date,
      categories,
      tags,
      featuredImageId,
    });

    const exec = async () => {
      const response = await client.post('/posts', payload);
      return response.data as { id: number; status: string; link: string };
    };

    try {
      const data = await withRetry(exec, {
        operation: 'createPost',
        url: `${apiBase}/posts`,
      });

      logger.info('WpClient.createPost - created WordPress post', {
        wpPostId: data.id,
        status: data.status,
      });

      return {
        id: data.id,
        status: data.status,
        link: data.link,
      };
    } catch (error) {
      const message = getAxiosErrorMessage(error);
      logger.error('WpClient.createPost - create post failed', {
        error: message,
        title,
      });
      throw error;
    }
  };

  const uploadMedia = async (options: UploadMediaOptions): Promise<UploadMediaResult> => {
    const { fileName, mimeType, buffer, altText, title } = options;

    const form = new FormData();
    form.append('file', buffer, {
      filename: fileName,
      contentType: mimeType,
    });

    if (altText) {
      form.append('alt_text', altText);
    }
    if (title) {
      form.append('title', title);
    }

    type WpMediaResponse = {
      id: number;
      source_url: string;
      media_type: string;
      mime_type: string;
    };

    const exec = async () => {
      const response = await client.post<WpMediaResponse>('/media', form, {
        headers: form.getHeaders(),
      });
      return response.data;
    };

    try {
      const data = await withRetry(exec, {
        operation: 'uploadMedia',
        url: `${apiBase}/media`,
      });

      logger.info('WpClient.uploadMedia - uploaded WordPress media', {
        wpMediaId: data.id,
        url: data.source_url,
      });

      return {
        id: data.id,
        url: data.source_url,
        mediaType: data.media_type,
        mimeType: data.mime_type,
      };
    } catch (error) {
      const message = getAxiosErrorMessage(error);
      logger.error('WpClient.uploadMedia - upload media failed', {
        error: message,
        fileName,
        mimeType,
        bufferLength: buffer.length,
        altText,
        title,
      });
      throw error;
    }
  };

  const deleteMedia = async (mediaId: number): Promise<void> => {
    try {
      await client.delete(`/media/${mediaId}?force=true`);
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;

      if (axiosError.isAxiosError && status === 404) {
        logger.warn('WpClient.deleteMedia - media already absent during rollback', {
          wpMediaId: mediaId,
        });
        return;
      }

      const message = getAxiosErrorMessage(error);
      logger.error('WpClient.deleteMedia - delete media during rollback failed', {
        error: message,
        wpMediaId: mediaId,
      });
      throw error;
    }
  };

  const deletePost = async (postId: number): Promise<void> => {
    try {
      await client.delete(`/posts/${postId}?force=true`);
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;

      if (axiosError.isAxiosError && status === 404) {
        logger.warn('WpClient.deletePost - post already absent during rollback', {
          wpPostId: postId,
        });
        return;
      }

      const message = getAxiosErrorMessage(error);
      logger.error('WpClient.deletePost - delete post during rollback failed', {
        error: message,
        wpPostId: postId,
      });
      throw error;
    }
  };

  const ensureCategory = async (name: string, parent: number = 0): Promise<number> => {
    // parent id is 0 by default. It means it's a root category.
    const cached = categoryCache.get(name); // categoryId
    if (cached != null) {
      return cached;
    }

    type WpCategory = {
      id: number;
      name: string;
      parent: number;
    };

    const searchExec: () => Promise<WpCategory | undefined> = async () => {
      let isNextPage = false;
      let page = 1;
      let category: WpCategory | undefined;
      do {
        const response = await client.get<WpCategory[]>(`/categories`, {
          params: { per_page: 100, page, search: encodeHtmlEntity(name) },
        });

        if (!response?.data || response?.data.length === 0) break;

        const fetched: WpCategory[] = response.data;
        const matched = fetched.filter(
          (cat) => cat.name === name || cat.name === encodeHtmlEntity(name)
        );
        if (matched.length > 0) {
          category = matched[0];
          break;
        }
        isNextPage = page < Number(response.headers['x-wp-totalpages'] || 1);
        page++;
      } while (isNextPage);
      return category;
    };

    const category = await withRetry(searchExec, {
      operation: 'searchCategory',
      url: `${apiBase}/categories`,
    });

    if (category) {
      categoryCache.set(name, category.id);
      return category.id;
    }

    // --- if not found, create it ---
    const createExec = async () => {
      const response = await client.post<WpCategory>('/categories', {
        name,
        parent,
      });
      return response.data;
    };

    const created: WpCategory = await withRetry(createExec, {
      operation: 'createCategory',
      url: `${apiBase}/categories`,
    });

    categoryCache.set(name, created.id);
    return created.id;
  };

  const ensureTag = async (name: string): Promise<number> => {
    const cached = tagCache.get(name);
    if (cached != null) {
      return cached;
    }

    type WpTag = {
      id: number;
      name: string;
    };

    const searchExec = async (): Promise<WpTag | undefined> => {
      let isNextPage = false;
      let page = 1;
      let tag: WpTag | undefined;
      do {
        const response = await client.get<WpTag[]>(`/tags`, {
          params: { per_page: 100, page, search: encodeHtmlEntity(name) },
        });

        if (!response?.data || response?.data.length === 0) break;

        const fetched: WpTag[] = response.data;
        const matched = fetched.filter((tag) => tag.name === encodeHtmlEntity(name));
        if (matched.length > 0) {
          tag = matched[0];
          break;
        }
        isNextPage = page < Number(response.headers['x-wp-totalpages'] || 1);
        page++;
      } while (isNextPage);
      return tag;
    };

    const tag: WpTag | undefined = await withRetry(searchExec, {
      operation: 'searchTag',
      url: `${apiBase}/tags`,
    });

    if (tag) {
      tagCache.set(name, tag.id);
      return tag.id;
    }

    // --- if not found, create it ---
    const createExec = async () => {
      const response = await client.post<WpTag>('/tags', { name });
      return response.data;
    };

    const created = await withRetry(createExec, {
      operation: 'createTag',
      url: `${apiBase}/tags`,
    });

    tagCache.set(name, created.id);
    return created.id;
  };

  return { createPost, uploadMedia, deleteMedia, deletePost, ensureCategory, ensureTag };
}
