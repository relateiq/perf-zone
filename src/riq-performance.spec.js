// bleh.... phantom
var riqPerformance = require('@web/riq-performance');
var tools = require('jasmine-tools-riq');


//THESE TESTS ARE HEISEN-TESTS, testing something that measures code is very hard, maybe come back to these but probably not
xdescribe('riq-performance', function() {
    beforeEach(function() {
        var self = this;
        self.container = document.createElement('div');
        document.body.appendChild(self.container);

        self.onTimelineSpy = jasmine.createSpy();

        self.setupEventTarget = function(type, onClick) {
            var target = document.createElement('button');
            target.addEventListener(type, onClick);
            self.container.appendChild(target);
            return target;
        };

        self.triggerTarget = function(target, type) {
            var event = document.createEvent('CustomEvent'); // MUST be 'CustomEvent'
            event.initCustomEvent(type, true, true);
            target.dispatchEvent(event);
        };

        jasmine.addMatchers({
            toBeTimeline: function() {
                return {
                    compare: function(actual, timeline) {
                        var pass = actual && actual.every(function(actualItem, i) {
                            var expectedItem = timeline[i];
                            return Object.keys(expectedItem).every(function(key) {
                                if (key === 'detail') {
                                    return Object.keys(expectedItem.detail).every(function(detailKey) {
                                        return actualItem.detail && actualItem.detail[key] === expectedItem.detail[key]
                                    });
                                }
                                return actualItem[key] === expectedItem[key];
                            });
                        });
                        return {
                            pass: pass,
                            message: tools.expectedObjectWithNot(actual, pass) + ' to have all properties of this timeline: ' + JSON.stringify(timeline)
                        };
                    }
                };
            }
        });

        self.expectAndCleanUp = function(done) {
            expect(self.onTimelineSpy).toHaveBeenCalled();
            expect(self.onTimelineSpy.calls.argsFor(0)[0]).toBeTimeline(self.expectedTimeline);
            if (self.expectedTimeline2) {
                expect(self.onTimelineSpy.calls.argsFor(1)[0]).toBeTimeline(self.expectedTimeline2);
            }
            riqPerformance.stop();
            document.body.removeChild(self.container);
            setTimeout(done, 1);
        };

    });

    it('should track a basic click to element addition', function(done) {
        var self = this;
        var target = self.setupEventTarget('click', function() {
            self.container.appendChild(document.createElement('span'));
        });
        riqPerformance.start(function() {
            self.onTimelineSpy.apply(this, arguments); //this one is actually this of the cb not self
            self.expectAndCleanUp(done);
        });
        self.triggerTarget(target, 'click');
        this.expectedTimeline = [{
            name: 'trigger',
            detail: {
                event_type: 'click'
            }
        }, {
            name: 'render'
        }];
    }, 40);

    it('should track a click even after a timeout to an element addition', function(done) {
        var self = this;
        var target1 = self.setupEventTarget('mouseover', function() {
            setTimeout(function() {
                self.container.appendChild(document.createElement('span'));
            }, 5);
        });
        var target2 = self.setupEventTarget('click', function() {
            self.container.appendChild(document.createElement('span'));
        });
        var calls = 0;
        riqPerformance.start(function() {
            self.onTimelineSpy.apply(this, arguments); //this one is actually this of the cb not self
            calls++;
            if (calls === 2) {
                self.expectAndCleanUp(done);
            }
        });
        self.triggerTarget(target1, 'mouseover');
        self.triggerTarget(target2, 'click');
        this.expectedTimeline = [{
            name: 'trigger',
            detail: {
                event_type: 'mouseover'
            }
        }, {
            name: 'render'
        }];
        this.expectedTimeline2 = [{
            name: 'trigger',
            detail: {
                event_type: 'click'
            }
        }, {
            name: 'render'
        }];
    }, 40);
})