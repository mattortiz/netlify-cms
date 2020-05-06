import semaphore, { Semaphore } from 'semaphore';
import { trimStart } from 'lodash';
import { stripIndent } from 'common-tags';
import {
  CURSOR_COMPATIBILITY_SYMBOL,
  filterByExtension,
  unsentRequest,
  basename,
  getBlobSHA,
  Entry,
  ApiRequest,
  Cursor,
  AssetProxy,
  PersistOptions,
  DisplayURL,
  Implementation,
  entriesByFolder,
  entriesByFiles,
  User,
  Credentials,
  getMediaDisplayURL,
  getMediaAsBlob,
  Config,
  ImplementationFile,
  unpublishedEntries,
  runWithLock,
  AsyncLock,
  asyncLock,
  getPreviewStatus,
  getLargeMediaPatternsFromGitAttributesFile,
  getPointerFileForMediaFileObj,
  getLargeMediaFilteredMediaFiles,
  FetchError,
  blobToFileObj,
  contentKeyFromBranch,
  generateContentKey,
  localForage,
  allEntriesByFolder,
  AccessTokenError,
  branchFromContentKey,
} from 'netlify-cms-lib-util';
import { NetlifyAuthenticator } from 'netlify-cms-lib-auth';
import AuthenticationPage from './AuthenticationPage';
import API, { API_NAME } from './API';
import { GitLfsClient } from './git-lfs-client';

const MAX_CONCURRENT_DOWNLOADS = 10;

// Implementation wrapper class
export default class BitbucketBackend implements Implementation {
  lock: AsyncLock;
  api: API | null;
  updateUserCredentials: (args: { token: string; refresh_token: string }) => Promise<null>;
  options: {
    proxied: boolean;
    API: API | null;
    updateUserCredentials: (args: { token: string; refresh_token: string }) => Promise<null>;
    initialWorkflowStatus: string;
  };
  repo: string;
  branch: string;
  apiRoot: string;
  baseUrl: string;
  siteId: string;
  token: string | null;
  mediaFolder: string;
  refreshToken?: string;
  refreshedTokenPromise?: Promise<string>;
  authenticator?: NetlifyAuthenticator;
  _mediaDisplayURLSem?: Semaphore;
  squashMerges: boolean;
  previewContext: string;
  largeMediaURL: string;
  _largeMediaClientPromise?: Promise<GitLfsClient>;
  authType: string;

  constructor(config: Config, options = {}) {
    this.options = {
      proxied: false,
      API: null,
      updateUserCredentials: async () => null,
      initialWorkflowStatus: '',
      ...options,
    };

    if (
      !this.options.proxied &&
      (config.backend.repo === null || config.backend.repo === undefined)
    ) {
      throw new Error('The BitBucket backend needs a "repo" in the backend configuration.');
    }

    this.api = this.options.API || null;

    this.updateUserCredentials = this.options.updateUserCredentials;

    this.repo = config.backend.repo || '';
    this.branch = config.backend.branch || 'master';
    this.apiRoot = config.backend.api_root || 'https://api.bitbucket.org/2.0';
    this.baseUrl = config.base_url || '';
    this.siteId = config.site_id || '';
    this.largeMediaURL =
      config.backend.large_media_url || `https://bitbucket.org/${config.backend.repo}/info/lfs`;
    this.token = '';
    this.mediaFolder = config.media_folder;
    this.squashMerges = config.backend.squash_merges || false;
    this.previewContext = config.backend.preview_context || '';
    this.lock = asyncLock();
    this.authType = config.backend.auth_type || '';
  }

  isGitBackend() {
    return true;
  }

  async status() {
    const auth =
      (await this.api
        ?.user()
        .then(user => !!user)
        .catch(e => {
          console.warn('Failed getting Bitbucket user', e);
          return false;
        })) || false;

    return { auth };
  }

  authComponent() {
    return AuthenticationPage;
  }

  setUser(user: { token: string }) {
    this.token = user.token;
    this.api = new API({
      requestFunction: this.apiRequestFunction,
      branch: this.branch,
      repo: this.repo,
      squashMerges: this.squashMerges,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    });
  }

  requestFunction = async (req: ApiRequest) => {
    const token = await this.getToken();
    const authorizedRequest = unsentRequest.withHeaders({ Authorization: `Bearer ${token}` }, req);
    return unsentRequest.performRequest(authorizedRequest);
  };

  restoreUser(user: User) {
    return this.authenticate(user);
  }

  async authenticate(state: Credentials) {
    this.token = state.token as string;
    this.refreshToken = state.refresh_token;
    this.api = new API({
      requestFunction: this.apiRequestFunction,
      branch: this.branch,
      repo: this.repo,
      apiRoot: this.apiRoot,
      squashMerges: this.squashMerges,
      initialWorkflowStatus: this.options.initialWorkflowStatus,
    });

    const isCollab = await this.api.hasWriteAccess().catch(error => {
      error.message = stripIndent`
        Repo "${this.repo}" not found.

        Please ensure the repo information is spelled correctly.

        If the repo is private, make sure you're logged into a Bitbucket account with access.
      `;
      throw error;
    });

    // Unauthorized user
    if (!isCollab) {
      throw new Error('Your BitBucket user account does not have access to this repo.');
    }

    const user = await this.api.user();

    // Authorized user
    return {
      ...user,
      name: user.display_name,
      login: user.username,
      token: state.token,
      // eslint-disable-next-line @typescript-eslint/camelcase
      avatar_url: user.links.avatar.href,
      // eslint-disable-next-line @typescript-eslint/camelcase
      refresh_token: state.refresh_token,
    };
  }

  getRefreshedAccessToken() {
    if (this.authType === 'implicit') {
      throw new AccessTokenError(`Can't refresh access token when using implicit auth`);
    }
    if (this.refreshedTokenPromise) {
      return this.refreshedTokenPromise;
    }

    // instantiating a new Authenticator on each refresh isn't ideal,
    if (!this.authenticator) {
      const cfg = {
        // eslint-disable-next-line @typescript-eslint/camelcase
        base_url: this.baseUrl,
        // eslint-disable-next-line @typescript-eslint/camelcase
        site_id: this.siteId,
      };
      this.authenticator = new NetlifyAuthenticator(cfg);
    }

    this.refreshedTokenPromise = this.authenticator! // eslint-disable-next-line @typescript-eslint/camelcase
      .refresh({ provider: 'bitbucket', refresh_token: this.refreshToken as string })
      // eslint-disable-next-line @typescript-eslint/camelcase
      .then(({ token, refresh_token }) => {
        this.token = token;
        // eslint-disable-next-line @typescript-eslint/camelcase
        this.refreshToken = refresh_token;
        this.refreshedTokenPromise = undefined;

        // eslint-disable-next-line @typescript-eslint/camelcase
        this.updateUserCredentials({ token, refresh_token });
        return token;
      });

    return this.refreshedTokenPromise;
  }

  logout() {
    this.token = null;
    return;
  }

  getToken() {
    if (this.refreshedTokenPromise) {
      return this.refreshedTokenPromise;
    }

    return Promise.resolve(this.token);
  }

  apiRequestFunction = async (req: ApiRequest) => {
    const token = (this.refreshedTokenPromise
      ? await this.refreshedTokenPromise
      : this.token) as string;

    const authorizedRequest = unsentRequest.withHeaders({ Authorization: `Bearer ${token}` }, req);
    const response: Response = await unsentRequest.performRequest(authorizedRequest);
    if (response.status === 401) {
      const json = await response.json().catch(() => null);
      if (json && json.type === 'error' && /^access token expired/i.test(json.error.message)) {
        const newToken = await this.getRefreshedAccessToken();
        const reqWithNewToken = unsentRequest.withHeaders(
          {
            Authorization: `Bearer ${newToken}`,
          },
          req,
        ) as ApiRequest;
        return unsentRequest.performRequest(reqWithNewToken);
      }
    }
    return response;
  };

  async entriesByFolder(folder: string, extension: string, depth: number) {
    let cursor: Cursor;

    const listFiles = () =>
      this.api!.listFiles(folder, depth, 20, this.branch).then(({ entries, cursor: c }) => {
        cursor = c.mergeMeta({ extension });
        return entries.filter(e => filterByExtension(e, extension));
      });

    const head = await this.api!.defaultBranchCommitSha();
    const readFile = (path: string, id: string | null | undefined) => {
      return this.api!.readFile(path, id, { head }) as Promise<string>;
    };

    const files = await entriesByFolder(
      listFiles,
      readFile,
      this.api!.readFileMetadata.bind(this.api),
      API_NAME,
    );

    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
    // @ts-ignore
    files[CURSOR_COMPATIBILITY_SYMBOL] = cursor;
    return files;
  }

  async listAllFiles(folder: string, extension: string, depth: number) {
    const files = await this.api!.listAllFiles(folder, depth, this.branch);
    const filtered = files.filter(file => filterByExtension(file, extension));
    return filtered;
  }

  async allEntriesByFolder(folder: string, extension: string, depth: number) {
    const head = await this.api!.defaultBranchCommitSha();

    const readFile = (path: string, id: string | null | undefined) => {
      return this.api!.readFile(path, id, { head }) as Promise<string>;
    };

    const files = await allEntriesByFolder({
      listAllFiles: () => this.listAllFiles(folder, extension, depth),
      readFile,
      readFileMetadata: this.api!.readFileMetadata.bind(this.api),
      apiName: API_NAME,
      branch: this.branch,
      localForage,
      folder,
      extension,
      depth,
      getDefaultBranch: () => Promise.resolve({ name: this.branch, sha: head }),
      isShaExistsInBranch: this.api!.isShaExistsInBranch.bind(this.api!),
      getDifferences: (source, destination) => this.api!.getDifferences(source, destination),
      getFileId: path => Promise.resolve(this.api!.getFileId(head, path)),
      filterFile: file => filterByExtension(file, extension),
    });
    return files;
  }

  async entriesByFiles(files: ImplementationFile[]) {
    const head = await this.api!.defaultBranchCommitSha();
    const readFile = (path: string, id: string | null | undefined) => {
      return this.api!.readFile(path, id, { head }) as Promise<string>;
    };

    return entriesByFiles(files, readFile, this.api!.readFileMetadata.bind(this.api), API_NAME);
  }

  getEntry(path: string) {
    return this.api!.readFile(path).then(data => ({
      file: { path, id: null },
      data: data as string,
    }));
  }

  getMedia(mediaFolder = this.mediaFolder) {
    return this.api!.listAllFiles(mediaFolder, 1, this.branch).then(files =>
      files.map(({ id, name, path }) => ({ id, name, path, displayURL: { id, path } })),
    );
  }

  getLargeMediaClient() {
    if (!this._largeMediaClientPromise) {
      this._largeMediaClientPromise = (async (): Promise<GitLfsClient> => {
        const patterns = await this.api!.readFile('.gitattributes')
          .then(attributes => getLargeMediaPatternsFromGitAttributesFile(attributes as string))
          .catch((err: FetchError) => {
            if (err.status === 404) {
              console.log('This 404 was expected and handled appropriately.');
            } else {
              console.error(err);
            }
            return [];
          });

        return new GitLfsClient(
          !!(this.largeMediaURL && patterns.length > 0),
          this.largeMediaURL,
          patterns,
          this.requestFunction,
        );
      })();
    }
    return this._largeMediaClientPromise;
  }

  getMediaDisplayURL(displayURL: DisplayURL) {
    this._mediaDisplayURLSem = this._mediaDisplayURLSem || semaphore(MAX_CONCURRENT_DOWNLOADS);
    return getMediaDisplayURL(
      displayURL,
      this.api!.readFile.bind(this.api!),
      this._mediaDisplayURLSem,
    );
  }

  async getMediaFile(path: string) {
    const name = basename(path);
    const blob = await getMediaAsBlob(path, null, this.api!.readFile.bind(this.api!));
    const fileObj = blobToFileObj(name, blob);
    const url = URL.createObjectURL(fileObj);
    const id = await getBlobSHA(fileObj);

    return {
      id,
      displayURL: url,
      path,
      name,
      size: fileObj.size,
      file: fileObj,
      url,
    };
  }

  async persistEntry(entry: Entry, mediaFiles: AssetProxy[], options: PersistOptions) {
    const client = await this.getLargeMediaClient();
    // persistEntry is a transactional operation
    return runWithLock(
      this.lock,
      async () =>
        this.api!.persistFiles(
          entry,
          client.enabled ? await getLargeMediaFilteredMediaFiles(client, mediaFiles) : mediaFiles,
          options,
        ),
      'Failed to acquire persist entry lock',
    );
  }

  async persistMedia(mediaFile: AssetProxy, options: PersistOptions) {
    const { fileObj, path } = mediaFile;
    const displayURL = URL.createObjectURL(fileObj);
    const client = await this.getLargeMediaClient();
    const fixedPath = path.startsWith('/') ? path.slice(1) : path;
    if (!client.enabled || !client.matchPath(fixedPath)) {
      return this._persistMedia(mediaFile, options);
    }

    const persistMediaArgument = await getPointerFileForMediaFileObj(client, fileObj as File, path);
    return {
      ...(await this._persistMedia(persistMediaArgument, options)),
      displayURL,
    };
  }

  async _persistMedia(mediaFile: AssetProxy, options: PersistOptions) {
    const fileObj = mediaFile.fileObj as File;

    const [id] = await Promise.all([
      getBlobSHA(fileObj),
      this.api!.persistFiles(null, [mediaFile], options),
    ]);

    const url = URL.createObjectURL(fileObj);

    return {
      displayURL: url,
      path: trimStart(mediaFile.path, '/k'),
      name: fileObj!.name,
      size: fileObj!.size,
      id,
      file: fileObj,
      url,
    };
  }

  deleteFile(path: string, commitMessage: string) {
    return this.api!.deleteFile(path, commitMessage);
  }

  traverseCursor(cursor: Cursor, action: string) {
    return this.api!.traverseCursor(cursor, action).then(async ({ entries, cursor: newCursor }) => {
      const extension = cursor.meta?.get('extension');
      if (extension) {
        entries = entries.filter(e => filterByExtension(e, extension));
        newCursor = newCursor.mergeMeta({ extension });
      }
      const head = await this.api!.defaultBranchCommitSha();
      const readFile = (path: string, id: string | null | undefined) => {
        return this.api!.readFile(path, id, { head }) as Promise<string>;
      };
      const entriesWithData = await entriesByFiles(
        entries,
        readFile,
        this.api!.readFileMetadata.bind(this.api)!,
        API_NAME,
      );

      return {
        entries: entriesWithData,
        cursor: newCursor,
      };
    });
  }

  async loadMediaFile(path: string, id: string, { branch }: { branch: string }) {
    const readFile = async (
      path: string,
      id: string | null | undefined,
      { parseText }: { parseText: boolean },
    ) => {
      const content = await this.api!.readFile(path, id, { branch, parseText });
      return content;
    };
    const blob = await getMediaAsBlob(path, id, readFile);
    const name = basename(path);
    const fileObj = blobToFileObj(name, blob);
    return {
      id: path,
      displayURL: URL.createObjectURL(fileObj),
      path,
      name,
      size: fileObj.size,
      file: fileObj,
    };
  }

  async unpublishedEntries() {
    const listEntriesKeys = () =>
      this.api!.listUnpublishedBranches().then(branches =>
        branches.map(branch => contentKeyFromBranch(branch)),
      );

    const ids = await unpublishedEntries(listEntriesKeys);
    return ids;
  }

  async unpublishedEntry({
    id,
    collection,
    slug,
  }: {
    id?: string;
    collection?: string;
    slug?: string;
  }) {
    if (id) {
      const data = await this.api!.retrieveUnpublishedEntryData(id);
      return data;
    } else if (collection && slug) {
      const entryId = generateContentKey(collection, slug);
      const data = await this.api!.retrieveUnpublishedEntryData(entryId);
      return data;
    } else {
      throw new Error('Missing unpublished entry id or collection and slug');
    }
  }

  getBranch(collection: string, slug: string) {
    const contentKey = generateContentKey(collection, slug);
    const branch = branchFromContentKey(contentKey);
    return branch;
  }

  async unpublishedEntryDataFile(collection: string, slug: string, path: string, id: string) {
    const branch = this.getBranch(collection, slug);
    const data = (await this.api!.readFile(path, id, { branch })) as string;
    return data;
  }

  async unpublishedEntryMediaFile(collection: string, slug: string, path: string, id: string) {
    const branch = this.getBranch(collection, slug);
    const mediaFile = await this.loadMediaFile(path, id, { branch });
    return mediaFile;
  }

  async updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    // updateUnpublishedEntryStatus is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.updateUnpublishedEntryStatus(collection, slug, newStatus),
      'Failed to acquire update entry status lock',
    );
  }

  async deleteUnpublishedEntry(collection: string, slug: string) {
    // deleteUnpublishedEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.deleteUnpublishedEntry(collection, slug),
      'Failed to acquire delete entry lock',
    );
  }

  async publishUnpublishedEntry(collection: string, slug: string) {
    // publishUnpublishedEntry is a transactional operation
    return runWithLock(
      this.lock,
      () => this.api!.publishUnpublishedEntry(collection, slug),
      'Failed to acquire publish entry lock',
    );
  }

  async getDeployPreview(collection: string, slug: string) {
    try {
      const statuses = await this.api!.getStatuses(collection, slug);
      const deployStatus = getPreviewStatus(statuses, this.previewContext);

      if (deployStatus) {
        const { target_url: url, state } = deployStatus;
        return { url, status: state };
      } else {
        return null;
      }
    } catch (e) {
      return null;
    }
  }
}
