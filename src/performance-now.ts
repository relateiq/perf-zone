(function() {
    if (!window) {
        return;
    }

    if (window['performance'] === undefined) {
        if (window['Performance'] !== undefined) {
            window['performance'] = new Performance();
        } else {
            window['performance'] = <Performance>{}; 
        }
            
    }

    Date.now = (Date.now || function() { // thanks IE8
        return new Date().getTime();
    });

    if (window.performance['now'] === undefined) {

        var nowOffset = Date.now();

        if (window.performance.timing && window.performance.timing.navigationStart) {
            nowOffset = window.performance.timing.navigationStart;
        }

        window.performance.now = function now() {
            return Date.now() - nowOffset;
        };
    }

})();
