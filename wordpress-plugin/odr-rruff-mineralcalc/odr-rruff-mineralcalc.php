<?php
/**
 * Plugin Name: ODR RRUFF Mineral Calculator
 * Description: A plugin that gives a way to break down a mineral's valence formula into its elemental mass percentages, formula mass, and net charge
 * Version: 1.3.6
 */

if (!defined('ABSPATH')) {
    exit; // No direct access.
}

function ormc_enqueue_assets() {
    wp_enqueue_style(
        'ormc-reset',
        plugin_dir_url(__FILE__) . 'reset.css',
        array(),
        filemtime(plugin_dir_path(__FILE__) . 'reset.css')
    );

    $dist_dir = plugin_dir_path(__FILE__) . 'dist/assets/';
    $dist_url = plugin_dir_url(__FILE__) . 'dist/assets/';

    $js_files = glob($dist_dir . 'index-*.js');
    if (empty($js_files)) {
        return;
    }
    $js_file = basename($js_files[0]);

    wp_enqueue_script(
        'ormc-app',
        $dist_url . $js_file,
        array(),
        filemtime($dist_dir . $js_file),
        true // load in footer
    );

    // The build output is an ES module.
    add_filter('script_loader_tag', function ($tag, $handle) {
        if ($handle === 'ormc-app') {
            $tag = str_replace(' src', ' type="module" src', $tag);
        }
        return $tag;
    }, 10, 2);

    $css_files = glob($dist_dir . 'index-*.css');
    if (!empty($css_files)) {
        $css_file = basename($css_files[0]);
        wp_enqueue_style(
            'ormc-app',
            $dist_url . $css_file,
            array(),
            filemtime($dist_dir . $css_file)
        );
    }
}

// ---------------------------------------------------------------------------
// ODR API proxy for ?UUID= links. The browser can't call the API directly
// (its CORS preflight returns 405). Login from the settings page or a .env.
// ---------------------------------------------------------------------------
define('ORMC_TOKEN_URL', 'https://www.rruff.net/odr_rruff/api/v4/token');
define('ORMC_RECORD_URL', 'https://www.rruff.net/odr_rruff/api/v4/dataset/record/');

// The .env lives above the web root, or in ORMC_ENV_DIR from wp-config.php.
function ormc_env_file() {
    $dirs = defined('ORMC_ENV_DIR') ? array(ORMC_ENV_DIR) : array(dirname(ABSPATH), ABSPATH);
    foreach ($dirs as $dir) {
        $file = rtrim($dir, '/\\') . '/.env';
        if (is_readable($file)) {
            return $file;
        }
    }
    return '';
}

// KEY => value pairs from the .env only, not getenv() (on Windows,
// 'username' is the OS account).
function ormc_dotenv() {
    $values = array();
    $file = ormc_env_file();
    if ($file === '') {
        return $values;
    }
    foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) {
            continue;
        }
        list($key, $value) = array_map('trim', explode('=', $line, 2));
        if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && substr($value, -1) === $value[0]) {
            $value = substr($value, 1, -1);
        }
        $values[$key] = $value;
    }
    return $values;
}

// The saved login, else the .env. Returns array(username, password).
function ormc_api_credentials() {
    $username = get_option('ormc_api_username', '');
    $password = get_option('ormc_api_password', '');
    if ($username !== '' && $password !== '') {
        return array($username, $password);
    }
    $env = ormc_dotenv();
    if (!empty($env['username']) && !empty($env['password'])) {
        return array($env['username'], $env['password']);
    }
    return array('', '');
}

// An API token, cached until a minute before it expires. Returns
// array(token, error), one of them ''.
function ormc_api_token() {
    $cached = get_transient('ormc_api_token_cache');
    if ($cached) {
        return array($cached, '');
    }

    list($username, $password) = ormc_api_credentials();
    if ($username === '' || $password === '') {
        return array('', 'no API login saved on Settings → Mineral Calculator, and ' . (ormc_env_file() === '' ? 'no .env file found' : 'the .env has no username / password values'));
    }

    $res = wp_remote_post(ORMC_TOKEN_URL, array(
        'headers' => array('Content-Type' => 'application/json'),
        'body'    => wp_json_encode(array('username' => $username, 'password' => $password)),
        'timeout' => 15,
    ));
    if (is_wp_error($res)) {
        return array('', 'token request failed: ' . $res->get_error_message());
    }
    $code = wp_remote_retrieve_response_code($res);
    $body = wp_remote_retrieve_body($res);
    if ($code < 200 || $code >= 300) {
        return array('', 'token request was rejected with HTTP ' . $code);
    }

    $data = json_decode($body, true);
    $token = is_array($data) ? ($data['token'] ?? $data['access_token'] ?? $data['jwt'] ?? '') : trim($body);
    if (!is_string($token) || $token === '') {
        return array('', 'token response did not include a token');
    }

    $ttl = 30 * MINUTE_IN_SECONDS;
    $parts = explode('.', $token);
    if (count($parts) === 3) {
        $payload = json_decode(base64_decode(strtr($parts[1], '-_', '+/')), true);
        if (isset($payload['exp'])) {
            $ttl = (int) $payload['exp'] - time() - MINUTE_IN_SECONDS;
        }
    }
    if ($ttl > 0) {
        set_transient('ormc_api_token_cache', $token, $ttl);
    }
    return array($token, '');
}

// Only admins see the detail.
function ormc_rest_error($message, $detail, $status) {
    if ($detail !== '' && current_user_can('manage_options')) {
        $message .= ' Server said: ' . $detail;
    }
    error_log('ODR RRUFF Mineral Calculator: ' . $message . ($detail !== '' ? ' (' . $detail . ')' : ''));
    return new WP_Error('ormc_record', $message, array('status' => $status));
}

function ormc_rest_record(WP_REST_Request $request) {
    list($token, $token_error) = ormc_api_token();
    if ($token === '') {
        return ormc_rest_error('The server could not get an API token.', $token_error, 500);
    }

    $res = wp_remote_get(ORMC_RECORD_URL . rawurlencode($request['uuid']), array(
        'headers' => array('Authorization' => 'Bearer ' . $token),
        'timeout' => 20,
    ));
    if (is_wp_error($res)) {
        return ormc_rest_error('The record request to the API failed.', $res->get_error_message(), 502);
    }

    $code = wp_remote_retrieve_response_code($res);
    if ($code === 401 || $code === 403) {
        // Log in afresh next time.
        delete_transient('ormc_api_token_cache');
        return ormc_rest_error('Request failed: ' . $code . ' - the API rejected the token.', '', $code);
    }
    if ($code < 200 || $code >= 300) {
        return ormc_rest_error('Request failed: ' . $code . '.', '', $code === 404 ? 404 : 502);
    }

    $data = json_decode(trim(wp_remote_retrieve_body($res)), true);
    if ($data === null) {
        return ormc_rest_error('The API returned a record that is not valid JSON.', '', 502);
    }
    return rest_ensure_response($data);
}

add_action('rest_api_init', function () {
    register_rest_route('odr-rruff-mineralcalc/v1', '/record/(?P<uuid>[0-9a-fA-F]{1,64})', array(
        'methods'             => 'GET',
        'callback'            => 'ormc_rest_record',
        // Public; the uuid pattern limits it to record lookups.
        'permission_callback' => '__return_true',
    ));
    register_rest_route('odr-rruff-mineralcalc/v1', '/elements', array(
        'methods'             => 'GET',
        'callback'            => 'ormc_rest_elements',
        'permission_callback' => '__return_true',
    ));
});

// ---------------------------------------------------------------------------
// Element data from the RRUFF FormulaCalcElements database, fetched and
// cached here so visitors don't each make ~110 API calls.
// ---------------------------------------------------------------------------
define('ORMC_ELEMENTS_LIST_URL', 'https://www.rruff.net/odr_rruff/api/v4/search/database/7064266bc2cd52543b43b679de22/records');
define('ORMC_ELEMENTS_CACHE_TTL', 12 * HOUR_IN_SECONDS);

// Every element record's fields, or a WP_Error. All or nothing, so a
// partial table is never cached.
function ormc_fetch_elements() {
    list($token, $token_error) = ormc_api_token();
    if ($token === '') {
        return ormc_rest_error('The server could not get an API token.', $token_error, 500);
    }
    $headers = array('Authorization' => 'Bearer ' . $token);

    $res = wp_remote_get(ORMC_ELEMENTS_LIST_URL, array('headers' => $headers, 'timeout' => 20));
    if (is_wp_error($res)) {
        return ormc_rest_error('The element list request to the API failed.', $res->get_error_message(), 502);
    }
    $code = wp_remote_retrieve_response_code($res);
    if ($code === 401 || $code === 403) {
        delete_transient('ormc_api_token_cache');
        return ormc_rest_error('Element list request failed: ' . $code . ' - the API rejected the token.', '', $code);
    }
    if ($code < 200 || $code >= 300) {
        return ormc_rest_error('Element list request failed: ' . $code . '.', '', 502);
    }
    $list = json_decode(wp_remote_retrieve_body($res), true);
    $uuids = array();
    foreach ((is_array($list) && isset($list['records']) ? $list['records'] : array()) as $record) {
        if (!empty($record['unique_id'])) {
            $uuids[] = $record['unique_id'];
        }
    }
    if (empty($uuids)) {
        return ormc_rest_error('The element database listed no records.', '', 502);
    }

    // Parallel batches. Requests moved under WpOrg in WordPress 6.2.
    $requests_class = class_exists('\WpOrg\Requests\Requests') ? '\WpOrg\Requests\Requests' : 'Requests';
    $options = array('timeout' => 20, 'verify' => ABSPATH . WPINC . '/certificates/ca-bundle.crt');
    $elements = array();
    foreach (array_chunk($uuids, 20) as $chunk) {
        $requests = array();
        foreach ($chunk as $uuid) {
            $requests[$uuid] = array('url' => ORMC_RECORD_URL . rawurlencode($uuid), 'headers' => $headers);
        }
        $responses = $requests_class::request_multiple($requests, $options);
        foreach ($chunk as $uuid) {
            $r = isset($responses[$uuid]) ? $responses[$uuid] : null;
            // A failed request comes back as an exception.
            if (!is_object($r) || !isset($r->status_code) || $r->status_code !== 200) {
                $detail = is_object($r) && isset($r->status_code) ? 'HTTP ' . $r->status_code
                    : (is_object($r) && method_exists($r, 'getMessage') ? $r->getMessage() : '');
                return ormc_rest_error('Element record ' . $uuid . ' could not be fetched.', $detail, 502);
            }
            $data = json_decode($r->body, true);
            $fields = array();
            foreach ((is_array($data) && isset($data['fields']) ? $data['fields'] : array()) as $field) {
                if (isset($field['field_name'])) {
                    $fields[$field['field_name']] = isset($field['value']) ? $field['value'] : null;
                }
            }
            $elements[] = $fields;
        }
    }
    return $elements;
}

// Raw values; the app validates them (elementsLoader.js).
function ormc_rest_elements() {
    $cached = get_transient('ormc_elements_cache');
    if ($cached !== false) {
        return rest_ensure_response($cached);
    }
    $elements = ormc_fetch_elements();
    if (is_wp_error($elements)) {
        // API down: serve the last good copy and retry in 10 minutes.
        $stale = get_option('ormc_elements_last_good');
        if ($stale) {
            set_transient('ormc_elements_cache', $stale, 10 * MINUTE_IN_SECONDS);
            return rest_ensure_response($stale);
        }
        return $elements;
    }
    set_transient('ormc_elements_cache', $elements, ORMC_ELEMENTS_CACHE_TTL);
    update_option('ormc_elements_last_good', $elements, false);
    return rest_ensure_response($elements);
}

// Settings page button: clear the cached element data.
add_action('admin_post_ormc_refresh_elements', function () {
    if (!current_user_can('manage_options')) {
        wp_die('Not allowed.');
    }
    check_admin_referer('ormc_refresh_elements');
    delete_transient('ormc_elements_cache');
    wp_safe_redirect(add_query_arg('ormc_elements_refreshed', '1', admin_url('options-general.php?page=ormc-settings')));
    exit;
});

// ---------------------------------------------------------------------------
// Settings → Mineral Calculator: the API login, kept server-side.
// ---------------------------------------------------------------------------
add_action('admin_init', function () {
    register_setting('ormc_settings', 'ormc_api_username', array(
        'type'              => 'string',
        'sanitize_callback' => 'ormc_sanitize_username',
        'default'           => '',
    ));
    register_setting('ormc_settings', 'ormc_api_password', array(
        'type'              => 'string',
        'sanitize_callback' => 'ormc_sanitize_password',
        'default'           => '',
    ));
});

// A new login clears the cached token.
function ormc_sanitize_username($value) {
    $value = sanitize_text_field($value);
    if ($value !== get_option('ormc_api_username', '')) {
        delete_transient('ormc_api_token_cache');
    }
    return $value;
}

// Blank keeps the saved password. Not sanitize_text_field, which strips
// characters a password may contain.
function ormc_sanitize_password($value) {
    $value = is_string($value) ? $value : '';
    if ($value === '') {
        return get_option('ormc_api_password', '');
    }
    delete_transient('ormc_api_token_cache');
    return $value;
}

add_action('admin_menu', function () {
    add_options_page('Mineral Calculator', 'Mineral Calculator', 'manage_options', 'ormc-settings', 'ormc_settings_page');
});

function ormc_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    $has_password = get_option('ormc_api_password', '') !== '';
    ?>
    <div class="wrap">
        <h1>Mineral Calculator</h1>
        <p>The RRUFF API login used to look up AMCSD records for <code>?UUID=</code> links and to load the element data. It stays on the server and is never sent to visitors' browsers.</p>
        <form method="post" action="options.php">
            <?php settings_fields('ormc_settings'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="ormc_api_username">API username</label></th>
                    <td><input type="text" id="ormc_api_username" name="ormc_api_username" class="regular-text" autocomplete="off" value="<?php echo esc_attr(get_option('ormc_api_username', '')); ?>"></td>
                </tr>
                <tr>
                    <th scope="row"><label for="ormc_api_password">API password</label></th>
                    <td>
                        <input type="password" id="ormc_api_password" name="ormc_api_password" class="regular-text" autocomplete="new-password" value="">
                        <p class="description"><?php echo $has_password ? 'A password is saved. Leave this blank to keep it.' : 'No password saved yet.'; ?></p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <h2>Element data</h2>
        <p>Atomic weights and valences come from the RRUFF FormulaCalcElements database and are cached for 12 hours. Refresh after editing the database to use the changes right away.</p>
        <?php if (isset($_GET['ormc_elements_refreshed'])) : ?>
            <div class="notice notice-success inline"><p>Cached element data cleared; the next page load fetches it fresh.</p></div>
        <?php endif; ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="ormc_refresh_elements">
            <?php wp_nonce_field('ormc_refresh_elements'); ?>
            <?php submit_button('Refresh element data', 'secondary', 'submit', false); ?>
        </form>
    </div>
    <?php
}

// Where the app finds the elements route.
function ormc_elements_url_attr() {
    return ' data-elements-url="' . esc_url(rest_url('odr-rruff-mineralcalc/v1/elements')) . '"';
}

// Where the app finds the record proxy.
function ormc_shortcode() {
    ormc_enqueue_assets();
    return '<div id="mineral-parser-root" data-record-url="' . esc_url(rest_url('odr-rruff-mineralcalc/v1/record/')) . '"' . ormc_elements_url_attr() . '></div>';
}
add_shortcode('odr-rruff-mineralcalc', 'ormc_shortcode');

// The metrics page, meant for its own page: the same bundle and root div,
// with data-view="metrics" telling main.jsx to show it instead of the
// calculator.
function ormc_metrics_shortcode() {
    ormc_enqueue_assets();
    return '<div id="mineral-parser-root" data-view="metrics"' . ormc_elements_url_attr() . '></div>';
}
add_shortcode('odr-rruff-mineralcalc-metrics', 'ormc_metrics_shortcode');
