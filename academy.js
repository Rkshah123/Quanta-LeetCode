/* ==================== technical interview academy ========================
   Revision material for the parts of an interview that are not a specific
   algorithm: language fluency, SQL, system design, OOP, DBMS, OS and networks.

   Why this is hand-written rather than generated
   ----------------------------------------------
   Every claim here is a general fact about how computers work, not copied
   editorial content. It is written to be checked, and each section says what it
   is claiming so a reader can disagree with it. Quota-style "most asked
   questions" content was deliberately left out: there is no permitted public
   dataset of interview questions, so inventing one would be fabrication.

   How progress is tracked
   -----------------------
   A checkbox per topic, stored on the device, plus a quiz that marks itself
   from the reader's own answers against explanations that are shown either way.
   Nothing is ever marked "learned" automatically - the user marks it. */

const ACADEMY_VERSION = 1;

/* Each topic has sections, and each section has points. A point is one thing to
   be able to explain. Keeping them as short strings means the page renders
   identically offline and there is no prose to fall out of date silently. */
const ACADEMY_TOPICS = [
  {
    key: "java",
    label: "Java",
    blurb: "What an interviewer actually checks when you say you know Java.",
    sections: [
      {
        title: "The collections map",
        points: [
          "ArrayList is a resizable array: O(1) get by index, O(n) insert in the middle, and it is not thread safe.",
          "LinkedList is a real doubly linked list: O(n) get by index, O(1) insert once you hold the node. Rarely the right answer in an interview.",
          "HashMap averages O(1) put and get, and is not ordered. It is not thread safe - ConcurrentHashMap is.",
          "TreeMap is sorted and O(log n), because it is a red-black tree.",
          "ArrayDeque is the stack and queue to reach for; it beats LinkedList and avoids the fixed-size trap of Stack and Queue."
        ]
      },
      {
        title: "Equality, hashing and identity",
        points: [
          "equals compares content, == compares references for objects.",
          "hashCode must be consistent with equals: equal objects must have equal hash codes, or HashMap silently fails to find them.",
          "Override equals and hashCode together, or neither.",
          "Objects.equals(a, b) is null-safe; a.equals(b) throws when a is null."
        ]
      },
      {
        title: "Concurrency, honestly",
        points: [
          "synchronized gives mutual exclusion and happens-before; it is the simplest correct answer.",
          "A volatile field guarantees visibility and ordering, not atomicity. A counter written volatile is still wrong.",
          "AtomicInteger is the right tool for a counter that several threads increment.",
          "An executor with a fixed pool is how you actually run parallel work; creating a thread per task is a bug in production.",
          "Concurrent modification: iterate over a CopyOnWriteArrayList, or use a ConcurrentHashMap, when another thread may change the collection."
        ]
      },
      {
        title: "What gets asked",
        points: [
          "Reverse a linked list - O(n) time, O(1) space with three pointers.",
          "Find the nth element from the end - one pass with two pointers a gap apart.",
          "Detect a cycle - Floyd's tortoise and hare, O(1) space.",
          "Merge k sorted lists - a min-heap of k heads, O(N log k).",
          "Design a class that supports add and getRandom in O(1) - a list plus a map from value to index."
        ]
      }
    ]
  },
  {
    key: "javascript",
    label: "JavaScript",
    blurb: "The parts of the language that change what your code does.",
    sections: [
      {
        title: "Values, not variables",
        points: [
          "let and const are block scoped; var is function scoped. Prefer const and only use let when you must reassign.",
          "== coerces types; === does not. Use === almost always.",
          "NaN !== NaN, so compare with Number.isNaN instead.",
          "typeof null is 'object' - a bug from 1995 kept for compatibility.",
          "Truthiness: '', 0, NaN, null and undefined are falsy; [] and {} are truthy."
        ]
      },
      {
        title: "The event loop",
        points: [
          "Synchronous code runs to completion before anything async starts.",
          "Then the microtask queue drains completely: promise callbacks and queueMicrotask, in order.",
          "Only after that does one macrotask run - a timer or an event handler.",
          "So a promise callback always beats setTimeout(0), however small the timeout.",
          "await is a promise, and everything after it runs in a microtask, even for a resolved value."
        ]
      },
      {
        title: "Objects and copying",
        points: [
          "Objects are passed by reference, so a function that mutates one changes the caller's object.",
          "Spread and Object.assign make a shallow copy: nested objects are still shared.",
          "structuredClone makes a real deep copy, including Dates and Maps.",
          "const prevents reassignment of the binding, not mutation of the object it points at."
        ]
      },
      {
        title: "Performance questions",
        points: [
          "Debounce for 'search as you type'; throttle for scroll and resize.",
          "requestAnimationFrame before animation, setTimeout/interval for actual delays.",
          "Array.prototype.sort is O(n log n) but not stable on every engine - do not rely on equal keys keeping order.",
          "map and filter build new arrays; forEach is for side effects only."
        ]
      }
    ]
  },
  {
    key: "sql",
    label: "SQL",
    blurb: "The queries that come up, and what they actually cost.",
    sections: [
      {
        title: "Joins",
        points: [
          "INNER JOIN keeps rows that match on both sides; LEFT JOIN keeps every left row and fills unmatched right columns with NULL.",
          "A LEFT JOIN followed by WHERE right_table.id IS NULL is the standard anti-join: find rows with no match.",
          "A join can multiply rows. If two one-to-many joins meet on the same table, count DISTINCT or the totals silently inflate.",
          "CROSS JOIN is the general case both INNER and OUTER joins specialise."
        ]
      },
      {
        title: "Grouping",
        points: [
          "GROUP BY collapses rows; every selected non-aggregate column must be in the GROUP BY or the result is undefined.",
          "COUNT(*) counts rows; COUNT(column) skips NULLs; COUNT(DISTINCT column) counts unique non-null values.",
          "HAVING filters groups after aggregation; WHERE filters rows before it. WHERE is cheaper because it runs first.",
          "SUM over an empty set is NULL, not 0 - COALESCE if you need a zero."
        ]
      },
      {
        title: "Windows and CTEs",
        points: [
          "ROW_NUMBER gives a unique rank; RANK ties share a number and leave gaps; DENSE_RANK ties share and does not.",
          "LAG and LEAD read the previous or next row in the partition - the standard way to compare with the previous row.",
          "OVER (PARTITION BY x ORDER BY y) defines the frame; the default frame is the whole partition, which is a common surprise.",
          "A recursive CTE (WITH ... UNION ALL) walks a tree or a graph, and needs a depth guard to terminate."
        ]
      },
      {
        title: "Indexes",
        points: [
          "An index trades write speed and storage for read speed.",
          "A composite index on (a, b) can serve a query on a alone, and on a with b - but not on b alone.",
          "A LIKE '%text' cannot use an index; LIKE 'text%' can.",
          "EXPLAIN shows the plan. Look for ALL on a large table: that is a full scan."
        ]
      }
    ]
  },
  {
    key: "oop",
    label: "OOP",
    blurb: "The four principles, applied rather than recited.",
    sections: [
      {
        title: "Abstraction and encapsulation",
        points: [
          "Encapsulation is not private fields; it is keeping a class's internal representation out of its callers' hands.",
          "An abstraction is what a thing does; encapsulation is how you are prevented from depending on how.",
          "Returning a defensive copy is encapsulation: the caller cannot mutate what you hold."
        ]
      },
      {
        title: "Inheritance and composition",
        points: [
          "Prefer composition. Inheritance couples a subclass to its parent's every detail.",
          "An is-a relationship justifies inheritance; has-a justifies composition.",
          "Fragile base class: a change in the parent silently breaks every child.",
          "Use an interface or abstract class to define a contract, and invert the dependency on it."
        ]
      },
      {
        title: "SOLID",
        points: [
          "Single responsibility: one reason to change. A class that both parses and saves has two.",
          "Open/closed: extend rather than edit. A switch on a type is the usual violation.",
          "Liskov: a subclass must honour the parent's contract, not just its signature.",
          "Interface segregation: a fat interface forces small users to depend on methods they do not call.",
          "Dependency inversion: depend on abstractions, so the detail does not choose the policy."
        ]
      },
      {
        title: "Design patterns worth naming",
        points: [
          "Strategy: swap an algorithm at runtime - this is how you avoid a growing switch.",
          "Observer: notify a list of dependents when something changes.",
          "Factory: centralise which concrete class gets created.",
          "Adapter: make an interface you did not control look like one you did.",
          "Builder: assemble a valid object that has many optional parts."
        ]
      }
    ]
  },
  {
    key: "dbms",
    label: "DBMS",
    blurb: "Transactions, isolation, and what normalisation buys you.",
    sections: [
      {
        title: "ACID",
        points: [
          "Atomicity: all of it or none of it, enforced by the log and undo.",
          "Consistency: the database moves from one valid state to another; constraints enforce this.",
          "Isolation: concurrent transactions do not see each other's partial work.",
          "Durability: a committed write survives a crash, because it reached the log on disk."
        ]
      },
      {
        title: "Isolation levels",
        points: [
          "Read uncommitted allows dirty reads: you can read another transaction's uncommitted work.",
          "Read committed allows non-repeatable reads: the same row can change between two reads in your transaction.",
          "Repeatable read guarantees a stable snapshot for your transaction.",
          "Serializable is the strictest and the most expensive: it behaves as if transactions ran one at a time.",
          "The actual level a database provides is not the level it claims; check it."
        ]
      },
      {
        title: "Normalisation",
        points: [
          "1NF: values are atomic, no repeating groups, no nested tables in a cell.",
          "2NF: no partial dependency - every non-key column depends on the whole key.",
          "3NF: no transitive dependency - non-key columns depend on the key, not on each other.",
          "Denormalise on purpose, for reads, once you have measured that you need to.",
          "The anomaly normalisation removes: update, insert and delete anomalies."
        ]
      },
      {
        title: "Storage and recovery",
        points: [
          "WAL: write the log before the page, so recovery replays or undoes as needed.",
          "Checkpoints let recovery start from a known point instead of the very beginning.",
          "B-tree indexes give logarithmic lookup and stay balanced on disk.",
          "MVCC lets readers see a consistent snapshot without blocking writers."
        ]
      }
    ]
  },
  {
    key: "os",
    label: "Operating systems",
    blurb: "Processes, memory and concurrency, at interview depth.",
    sections: [
      {
        title: "Processes and threads",
        points: [
          "A process has its own address space; threads in one process share it.",
          "Context switching costs time, which is why too many threads hurts.",
          "Threads are for overlapping waiting, not for making CPU-bound work faster.",
          "fork duplicates the address space (copy on write); exec replaces the process image."
        ]
      },
      {
        title: "Scheduling",
        points: [
          "Preemptive: the OS can interrupt a running process. Non-preemptive: it cannot.",
          "Round robin gives each a slice; it is fair and poor for anything interactive.",
          "Priority scheduling can starve low-priority work unless ageing is used.",
          "A context switch is not free: save and restore registers and possibly a TLB flush."
        ]
      },
      {
        title: "Memory",
        points: [
          "A page fault is not an error; it is how a page gets loaded on demand.",
          "Virtual memory gives each process its own address space, and isolation comes from it.",
          "A page fault on an unmapped address is a genuine fault and kills the process.",
          "Belady's anomaly: more frames can mean more faults for the same algorithm.",
          "TLB caches address translations; a TLB miss costs a walk down the page table."
        ]
      },
      {
        title: "Deadlocks",
        points: [
          "Four conditions, all required: mutual exclusion, hold and wait, no preemption, circular wait.",
          "Prevention breaks one condition up front; detection-and-recovery allows them and resolves when they happen.",
          "Prevention is easier to reason about; recovery is easier to deploy.",
          "Banker's algorithm is avoidance: grant a request only if the system can still stay safe."
        ]
      }
    ]
  },
  {
    key: "networks",
    label: "Computer networks",
    blurb: "Layer by layer, with the handshake questions that actually get asked.",
    sections: [
      {
        title: "The layers",
        points: [
          "Application, transport, network, link, physical. Each hides the layer below's mechanics.",
          "TCP is connection-oriented and guarantees delivery order; UDP is not.",
          "TCP's three-way handshake: SYN, SYN-ACK, ACK. It costs a round trip before any data moves.",
          "The four-way teardown is slower because each side closes independently."
        ]
      },
      {
        title: "TCP in detail",
        points: [
          "Sliding window for flow control; the window is what limits throughput.",
          "Congestion control: slow start doubles the window per RTT until loss, then backs off.",
          "ACKs can be cumulative, so one ACK can cover many packets.",
          "Keepalive detects a dead peer that never sends FIN - which is most real failures."
        ]
      },
      {
        title: "HTTP",
        points: [
          "GET is safe and idempotent; POST is not.",
          "200 ok, 201 created, 301 permanent redirect, 302 temporary, 400 bad request, 401 unauthenticated, 403 forbidden, 404 not found, 500 server error.",
          "Keep-alive reuses one connection for many requests.",
          "Caching is controlled by Cache-Control, ETag and Last-Modified."
        ]
      },
      {
        title: "DNS and security",
        points: [
          "DNS resolves a name to an address, recursively, with caching at every step.",
          "TLS gives confidentiality, integrity and authentication, and needs a certificate to authenticate the server.",
          "A symmetric key is fast and must be shared; a public key can be published.",
          "A digital signature proves who signed; a hash proves the content has not changed."
        ]
      }
    ]
  }
];

/* The quiz. Each question has an answer and a reason that works whether the
   reader is right or wrong - there is no silent "incorrect" state. */
const ACADEMY_QUIZ = [
  {
    topic: "javascript",
    question: "Which runs first?",
    code: 'console.log("A");\nPromise.resolve().then(() => console.log("B"));\nsetTimeout(() => console.log("C"), 0);',
    options: ['"A", then "B", then "C"', '"A", then "C", then "B"'],
    answer: 0,
    why: 'Synchronous code runs first. Then the microtask queue drains completely - that is "B". Only after that does one timer callback run, so "C" is last.'
  },
  {
    topic: "sql",
    question: "What does COUNT(column) return for a column that is NULL?",
    options: ["It counts the row", "It skips the row"],
    answer: 1,
    why: "COUNT(column) ignores NULLs. COUNT(*) counts rows regardless, which is why the two differ on a table with NULLs."
  },
  {
    topic: "oop",
    question: "Which composition keyword replaces a growing type check?",
    options: ["switch", "Strategy pattern"],
    answer: 1,
    why: "A switch on a type must be edited every time a case is added. Strategy makes the behaviour something you pass in, so new cases are new classes, not edits to existing code."
  },
  {
    topic: "os",
    question: "Which of these is NOT one of the four deadlock conditions?",
    options: ["Hold and wait", "Preemptive scheduling"],
    answer: 1,
    why: "The four are mutual exclusion, hold and wait, no preemption, and circular wait. Preemptive scheduling is not one of them."
  },
  {
    topic: "networks",
    question: "Why does opening a TCP connection cost a round trip before any data?",
    options: ["Because of congestion control", "Because of the three-way handshake"],
    answer: 1,
    why: "The three-way handshake: SYN, SYN-ACK, ACK. Both sides confirm they can send and receive before any data moves, and that round trip is the deliberate cost of TCP's reliability guarantee."
  },
  {
    topic: "java",
    question: "You override equals but not hashCode. What happens?",
    options: ["Nothing changes", "Equal objects can end up in different hash buckets"],
    answer: 1,
    why: "HashMap puts an object in a bucket chosen by hashCode, then compares with equals inside it. With an inconsistent hashCode, two equal objects land in different buckets and the map can miss one."
  },
  {
    topic: "dbms",
    question: "Which isolation level allows reading another transaction's uncommitted writes?",
    options: ["Read uncommitted", "Repeatable read"],
    answer: 0,
    why: "That is what read uncommitted permits - a dirty read. Repeatable read guarantees a stable snapshot instead."
  }
];

/* Reads the saved progress and merges it over the static content. Anything
   missing falls back to the default rather than disappearing, so a stale save
   can never hide a section. */
const academyLoadProgress = (readJson) => {
  const key = `quantaAcademyV${ACADEMY_VERSION}`;
  const raw = readJson(key, () => ({}));
  const saved = raw && typeof raw === "object" ? raw : {};
  const done = saved.done instanceof Set ? saved.done : new Set(Array.isArray(saved.done) ? saved.done : []);
  const answered = saved.answered && typeof saved.answered === "object" ? saved.answered : {};
  return { key, done, answered };
};

/* Exposed for both environments: scripts/test-academy.js requires this in Node,
   and the page reads it from `window`. */
const ACADEMY_API = { ACADEMY_TOPICS, ACADEMY_QUIZ, ACADEMY_VERSION };

if (typeof window !== "undefined" && window) {
  window.ACADEMY_TOPICS = ACADEMY_TOPICS;
  window.ACADEMY_QUIZ = ACADEMY_QUIZ;
  window.ACADEMY_VERSION = ACADEMY_VERSION;
  window.academyContent = ACADEMY_API;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ACADEMY_API;
}
