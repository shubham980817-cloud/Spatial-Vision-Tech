(function () {
  let currentUser = null;

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData)) {
      headers.set('content-type', 'application/json');
    }
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const result = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  }

  async function getPasswordSalt(email) {
    return request(`/api/auth/password-salt?email=${encodeURIComponent(email.trim().toLowerCase())}`);
  }

  async function derivePassword(password, saltInfo) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      salt: Uint8Array.from(atob(saltInfo.salt), character => character.charCodeAt(0)),
      iterations: saltInfo.iterations,
      hash: 'SHA-256'
    }, key, 256);
    let binary = '';
    new Uint8Array(bits).forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function auth() {
    return {
      get currentUser() {
        return currentUser;
      },
      async registerStudent(profile) {
        const { email, password, profile: studentProfile } = profile;
        const saltInfo = await getPasswordSalt(email);
        const result = await request('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            email,
            profile: studentProfile,
            passwordVerifier: await derivePassword(password, saltInfo)
          })
        });
        currentUser = result.user;
        return result;
      },
      async signInWithEmailAndPassword(email, password) {
        const saltInfo = await getPasswordSalt(email);
        const result = await request('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, passwordVerifier: await derivePassword(password, saltInfo) })
        });
        currentUser = result.user;
        return { user: currentUser };
      },
      async sendPasswordResetEmail(email) {
        return request('/api/auth/reset', {
          method: 'POST',
          body: JSON.stringify({ email })
        });
      },
      async signOut() {
        await request('/api/auth/logout', { method: 'POST' });
        currentUser = null;
      }
    };
  }

  function snapshot(id, data) {
    return {
      id,
      exists: data !== null,
      data: () => data
    };
  }

  function store() {
    const api = {
      collection(name) {
        const query = {
          filters: [],
          sort: null,
          maxResults: null,
          where(field, operator, value) {
            if (operator !== '==') throw new Error('Only equality filters are supported.');
            this.filters.push({ field, value });
            return this;
          },
          orderBy(field, direction = 'asc') {
            this.sort = { field, direction };
            return this;
          },
          limit(count) {
            this.maxResults = count;
            return this;
          },
          async get() {
            if (this.filters.length > 1) throw new Error('Only one collection filter is supported.');
            const parameters = new URLSearchParams();
            if (this.filters[0]) {
              parameters.set('whereField', this.filters[0].field);
              parameters.set('whereValue', this.filters[0].value);
            }
            if (this.sort) {
              parameters.set('orderBy', this.sort.field);
              parameters.set('direction', this.sort.direction);
            }
            if (this.maxResults) parameters.set('limit', this.maxResults);
            const result = await request(`/api/collections/${encodeURIComponent(name)}?${parameters}`);
            const docs = result.documents.map(item => snapshot(item.id, item.data));
            return {
              docs,
              empty: docs.length === 0,
              forEach(callback) {
                docs.forEach(callback);
              }
            };
          },
          doc(id) {
            return {
              async get() {
                try {
                  const result = await request(`/api/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}`);
                  return snapshot(result.id, result.data);
                } catch (error) {
                  if (error.message === 'Record not found.') return snapshot(id, null);
                  throw error;
                }
              },
              async set(data) {
                return request(`/api/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, {
                  method: 'PUT',
                  body: JSON.stringify({ mode: 'set', data })
                });
              },
              async update(data) {
                return request(`/api/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, {
                  method: 'PUT',
                  body: JSON.stringify({ mode: 'update', data })
                });
              },
              async delete() {
                return request(`/api/collections/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
              }
            };
          },
          async add(data) {
            const result = await request(`/api/collections/${encodeURIComponent(name)}`, {
              method: 'POST',
              body: JSON.stringify(data)
            });
            return { id: result.id, notificationWarning: result.notificationWarning };
          }
        };
        return query;
      }
    };
    return api;
  }

  window.svtApi = { request };
  window.svt = {
    request,
    auth,
    derivePassword,
    getPasswordSalt,
    store: Object.assign(store, {
      FieldValue: {
        arrayUnion(...values) {
          return { __arrayUnion: values };
        }
      }
    }),
    async setStudentPassword({ studentUid, password }) {
      const saltInfo = await request(`/api/admin/students/${encodeURIComponent(studentUid)}/password-salt`);
      return request(`/api/admin/students/${encodeURIComponent(studentUid)}/password`, {
        method: 'POST',
        body: JSON.stringify({ passwordVerifier: await derivePassword(password, saltInfo) })
      });
    }
  };
})();
