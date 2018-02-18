import Mocha from "mocha";
import MochaParallel from "mocha-parallel-tests";
import Ganache from "ganache-core";
import path from "path";
import fs, { watchFile } from "fs";
import Web3 from "web3";
import originalrequire from "original-require";
import Resolver from "truffle-resolver";
import Contracts from "truffle-workflow-compile";
import Migrate from "truffle-migrate";
import Profiler from "truffle-compile/profiler.js";
import { Config, TestResolver, TestSource, TestRunner } from "./testing";

const getConfig = function() {
  let config = Config.detect({
    workingDirectory: path.resolve("."),
    buildFolder: ".test",
    networks: {
      test: {
        host: "localhost",
        port: 8545,
        network_id: "*" // match any network
      }
    }
  });

  // if "development" exists, default to using that for testing
  // if (!config.network && config.networks.development) {
  //   config.network = "development";
  // }

  config.network = "test";

  return config;
};

const getAccounts = function(web3) {
  return new Promise(function(resolve, reject) {
    web3.eth.getAccounts(function(err, res) {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
};

const mochaTemplate = function(runner, tests, accounts) {
  before("prepare suite", function(done) {
    runner.initialize(done);
  });

  beforeEach("before test", function(done) {
    runner.startTest(this, done);
  });

  afterEach("after test", function(done) {
    runner.endTest(this, done);
  });

  tests(accounts);
};

const compileContracts = function(config, test_resolver) {
  return new Promise(function(resolve, reject) {
    Profiler.updated(
      config.with({
        resolver: test_resolver
      }),
      function(err, updated) {
        if (err) return reject(err);

        updated = updated || [];

        // Compile project contracts and test contracts
        Contracts.compile(
          config.with({
            all: config.compileAll === true,
            files: updated,
            resolver: test_resolver,
            quiet: false,
            quietWrite: true
          }),
          function(err, abstractions, paths) {
            if (err) return reject(err);
            resolve(paths);
          }
        );
      }
    );
  });
};

const hideCursor = () => {
  process.stdout.write("\u001b[?25l");
};

const showCursor = () => {
  process.stdout.write("\u001b[?25h");
};

const watch = (config, files, callback) => {
  let options = { interval: 100 };
  files.forEach(function(file) {
    watchFile(file, options, function(curr, prev) {
      if (prev.mtime < curr.mtime) {
        callback();
      }
    });
  });
};

const performDeploy = function(config, resolver) {
  return new Promise(function(resolve, reject) {
    Migrate.run(
      config.with({
        reset: true,
        resolver: resolver,
        quiet: true
      }),
      function(err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
};

export default async function(testPath, watchOption) {
  let config = getConfig();

  console.log(config.provider);

  let server = Ganache.server();

  const chain = await server.listen(8545, (err, chain) => {
    return chain;
  });

  console.log("Launched", chain);

  let web3 = new Web3();

  web3.setProvider(config.provider);

  let mocha = new MochaParallel();
  let watchFiles = [];
  let files = [];

  const stats = fs.lstatSync(testPath);
  if (stats.isFile() && testPath.substr(-3) === ".js") {
    files = [path.resolve(testPath)];
  } else if (stats.isDirectory()) {
    files = fs.readdirSync(path.resolve(testPath)).filter(function(file) {
      // Only keep the .js files
      return file.substr(-3) === ".js";
    });
  }

  files.forEach(function(file) {
    delete originalrequire.cache[file];
    watchFiles.push(path.join(config.test_directory, file));
  });

  // Set accounts
  let accounts = await getAccounts(web3);
  if (!config.from) {
    config.networks[config.network].from = accounts[0];
  }

  // from truffle test.js
  if (!config.resolver) {
    config.resolver = new Resolver(config);
  }

  let testSource = new TestSource(config);

  let testResolver = new TestResolver(
    config.resolver,
    testSource,
    config.contracts_build_directory
  );
  testResolver.cache_on = false;

  let dependencyPaths = await compileContracts(config, testResolver);

  let runner = new TestRunner(config);

  await performDeploy(config, testResolver);

  global.web3 = web3;
  global.artifacts = {
    require: function(import_path) {
      return testResolver.require(import_path);
    }
  };

  global.contract = function(name, tests) {
    Mocha.describe("Contract: " + name, function() {
      mochaTemplate.bind(this, runner, tests, accounts)();
    });
  };

  global.contract.only = function(name, tests) {
    Mocha.describe.only("Contract: " + name, function() {
      mochaTemplate.bind(this, runner, tests, accounts)();
    });
  };

  process.on("unhandledRejection", function(reason, p) {
    throw reason;
  });

  if (watchOption === true) {
    hideCursor();
    process.on("SIGINT", () => {
      showCursor();
      console.log("\n");
      process.exit(130);
    });

    let runAgain = false;
    let runnerStub;

    const loadAndRun = () => {
      try {
        // Add each .js file to the mocha instance
        files.forEach(function(file) {
          mocha.addFile(path.join(config.test_directory, file));
        });
        runner = new TestRunner(config);
        runAgain = false;
        runnerStub = mocha.run(() => {
          runnerStub = null;
          if (runAgain) {
            rerun();
          }
        });
      } catch (e) {
        console.log(e.stack);
      }
    };

    const purge = () => {
      watchFiles.forEach(file => {
        delete originalrequire.cache[file];
      });
    };

    loadAndRun();

    const rerun = () => {
      purge();
      mocha.suite = mocha.suite.clone();
      mocha.suite.ctx = new MochaParallel.Context();
      loadAndRun();
    };

    watch(config, watchFiles, () => {
      console.log("Change detected");
      runAgain = true;
      if (runnerStub) {
        runnerStub.abort();
      } else {
        rerun();
      }
    });
  } else {
    files.forEach(function(file) {
      mocha.addFile(path.join(config.test_directory, file));
    });
    // Run the tests.
    mocha.run(function(failures) {
      process.on("exit", function() {
        process.exit(failures); // exit with non-zero status if there were failures
      });
      server.close();
    });
  }
}
