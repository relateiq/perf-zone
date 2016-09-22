(function () {
    if (!window) {
        return;
    }

    if ('performance' in window === undefined) {
        window['performance'] = new Performance();
    }

    Date.now = (Date.now || function () { // thanks IE8
        return new Date().getTime();
    });

    if ('now' in window.performance === undefined) {

        var nowOffset = Date.now();

        if (window.performance.timing && window.performance.timing.navigationStart) {
            nowOffset = window.performance.timing.navigationStart;
        }

        window.performance.now = function now() {
            return Date.now() - nowOffset;
        };
    }

})();
