Manual tests:

1. Install (squirrel, dmg, deb)
2. proxy: 
  * http -> https
  * https -> http
  * http -> http
  * https -> https
  * redirects rewrite - toggle off an on 
3. Breakpoints:
  * stops at some requests (one stops and one does not)
  * Manipulates headers
  * Manipulates body
4. Interceptors:
  * Request interceptor:
    * Manipulates headers
    * Manipulates body
  * Response interceptor:
    * Manipulates headers
    * Manipulates body
    * Manipulates status code
    