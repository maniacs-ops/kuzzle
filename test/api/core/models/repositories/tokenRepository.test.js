var
  jwt = require('jsonwebtoken'),
  Promise = require('bluebird'),
  should = require('should'),
  /** @type {Params} */
  params = require('rc')('kuzzle'),
  kuzzle = {
    repositories: {},
    services: {
      list: {}
    },
    config: require.main.require('lib/config')(params)
  },
  sinon = require('sinon'),
  sandbox = sinon.sandbox.create(),
  context = {connection: {id: 'papagayo'}},
  InternalError = require.main.require('kuzzle-common-objects').Errors.internalError,
  UnauthorizedError = require.main.require('kuzzle-common-objects').Errors.unauthorizedError,
  Profile = require.main.require('lib/api/core/models/security/profile'),
  Token = require.main.require('lib/api/core/models/security/token'),
  User = require.main.require('lib/api/core/models/security/user'),
  Role = require.main.require('lib/api/core/models/security/role'),
  Repository = require.main.require('lib/api/core/models/repositories/repository'),
  TokenRepository = require.main.require('lib/api/core/models/repositories/tokenRepository')(kuzzle),
  tokenRepository;

beforeEach(function (done) {
  var
    mockCacheEngine,
    mockProfileRepository,
    mockUserRepository,
    tokenInCache;

  mockCacheEngine = {
    get: function (key) {
      if (key === tokenRepository.index + '/' + tokenRepository.collection + '/tokenInCache') {
        return Promise.resolve(JSON.stringify(tokenInCache));
      }
      return Promise.resolve(null);
    },
    volatileSet: function () {
      return Promise.resolve('OK');
    },
    expire: function (key, ttl) { return Promise.resolve({key: key, ttl: ttl}); }
  };

  mockProfileRepository = {
    loadProfile: function (profileKey) {
      var profile = new Profile();
      profile._id = profileKey;
      return Promise.resolve(profile);
    }
  };

  mockUserRepository = {
    load: function (username) {
      var user = new User();
      user._id = username;
      user.profileId = 'anonymous';

      return Promise.resolve(user);
    },
    anonymous: function () {
      var
        role = new Role(),
        profile = new Profile(),
        user = new User();

      role._id = 'anonymous';
      role.controllers = {
        '*': {
          actions: {
            '*': true
          }
        }
      };

      user._id = -1;
      user.profileId = 'anonymous';
      profile.policies = [{_id: role._id}];

      return Promise.resolve(user);
    },
    admin: function () {
      var
        role = new Role(),
        profile = new Profile(),
        user = new User();

      role._id = 'admin';
      role.controllers = {
        '*': {
          actions: {
            '*': true
          }
        }
      };

      user._id = 'admin';
      user.profileId = 'admin';
      profile.policies = [{_id: role._id}];

      return Promise.resolve(user);
    }
  };

  tokenInCache = {
    _id: 'tokenInCache',
    user: 'admin'
  };

  tokenRepository = new TokenRepository();
  tokenRepository.cacheEngine = mockCacheEngine;

  kuzzle.repositories = {};
  kuzzle.repositories.profile = mockProfileRepository;
  kuzzle.repositories.user = mockUserRepository;


  kuzzle.tokenManager = {
    add: function () {},
    expire: function () {},
    checkTokensValidity: function () {}
  };

  done();
});

afterEach(() => {
  sandbox.restore();
});

describe('Test: repositories/tokenRepository', function () {
  describe('#constructor', () => {
    it('should take into account the options given', () => {
      var repository = new TokenRepository({ ttl: 1000 });

      should(repository.ttl).be.exactly(1000);
    });
  });

  describe('#anonymous', function () {
    it('should return a valid anonymous token', function (done) {
      tokenRepository.anonymous()
        .then(function (token) {
          assertIsAnonymous(token);
          done();
        })
        .catch(function (error) {
          done(error);
        });
    });
  });

  describe('#hydrate', function () {
    it('should return the given token if the given data is not a valid object', function () {
      var
        t = new Token();

      return Promise.all([
        tokenRepository.hydrate(t, null),
        tokenRepository.hydrate(t),
        tokenRepository.hydrate(t, 'a scalar')
      ])
        .then(results => results.forEach(token => should(token).be.exactly(t)));
    });

    it('should return the anonymous token if no _id is set', done => {
      var token = new Token();

      tokenRepository.hydrate(token, {})
        .then(result => {
          assertIsAnonymous(result);
          done();
        })
        .catch(err => { done(err); });
    });
  });

  describe('#verifyToken', function () {
    it('should reject the promise if the jwt is invalid', function () {
      return should(tokenRepository.verifyToken('invalidToken')).be.rejectedWith(UnauthorizedError, {
        details: {
          subCode: UnauthorizedError.prototype.subCodes.JsonWebTokenError,
          description: 'jwt malformed'
        }
      });
    });

    it('should reject the token if the uuid is not known', function () {
      var
        token;

      token = jwt.sign({_id: -99999}, params.jsonWebToken.secret, {algorithm: params.jsonWebToken.algorithm});

      return should(tokenRepository.verifyToken(token)).be.rejectedWith(UnauthorizedError, {
        message: 'Invalid token'
      });
    });

    it('shoud reject the promise if the jwt is expired', function () {
      var token = jwt.sign({_id: -1}, params.jsonWebToken.secret, {algorithm: params.jsonWebToken.algorithm, expiresIn: 0});

      return should(tokenRepository.verifyToken(token)).be.rejectedWith(UnauthorizedError, {
        details: {
          subCode: UnauthorizedError.prototype.subCodes.TokenExpired
        }
        });
    });

    it('should reject the promise if an error occurred while fetching the user from the cache', () => {
      var token = jwt.sign({_id: 'auser'}, params.jsonWebToken.secret, {algorithm: params.jsonWebToken.algorithm});

      sandbox.stub(tokenRepository, 'loadFromCache').rejects(new InternalError('Error'));

      return should(tokenRepository.verifyToken(token)).be.rejectedWith(InternalError);
    });

    it('should load the anonymous user if the token is null', () => {
      return tokenRepository.verifyToken(null)
        .then(userToken => assertIsAnonymous(userToken));
    });
  });

  describe('#generateToken', function () {
    it('should reject the promise if the username is null', function () {
      return should(tokenRepository.generateToken(null)).be.rejectedWith(InternalError);
    });

    it('should reject the promise if the context is null', function () {
      return should(tokenRepository.generateToken(new User(), null)).be.rejectedWith(InternalError);
    });

    it('should reject the promise if an error occurred while generating the token', () => {

      kuzzle.config.jsonWebToken.algorithm = 'fake JWT ALgorithm';

      return should(tokenRepository.generateToken(new User(), context)
        .catch(err => {
          kuzzle.config.jsonWebToken.algorithm = params.jsonWebToken.algorithm;

          return Promise.reject(err);
        })).be.rejectedWith(InternalError);
    });

    it('should resolve to the good jwt token for a given username', function (done) {
      var
        user = new User(),
        checkToken = jwt.sign({_id: 'userInCache'}, params.jsonWebToken.secret, {
          algorithm: params.jsonWebToken.algorithm,
          expiresIn: params.jsonWebToken.expiresIn
        });

      user._id = 'userInCache';

      tokenRepository.generateToken(user, context)
        .then(function (token) {
          should(token).be.an.instanceOf(Token);
          should(token._id).be.exactly(checkToken);

          done();
        })
        .catch(function (error) {
          done(error);
        });
    });

    it('should return an internal error if an error append when generating token', (done) => {
      var
        user = new User();

      user._id = 'userInCache';

      tokenRepository.generateToken(user, context, {expiresIn: 'toto'})
        .catch(function (error) {
          should(error).be.an.instanceOf(InternalError);
          should(error.message).be.exactly('Error while generating token');
          done();
        });
    });

  });

  describe('#serializeToCache', function () {
    it('should return a valid plain object', function (done) {
      tokenRepository.anonymous()
        .then(function (token) {
          var result = tokenRepository.serializeToCache(token);

          should(result).not.be.an.instanceOf(Token);
          should(result).be.an.Object();
          should(result._id).be.exactly(undefined);
          should(result.userId).be.exactly(-1);

          done();
        })
        .catch(function (error) {
          done(error);
        });
    });
  });

  describe('#expire', () => {
    it('should be able to expires a token', (done) => {
      var
        user = new User();

      user._id = 'userInCache';

      tokenRepository.generateToken(user, context)
        .then(function (token) {
          return tokenRepository.expire(token);
        })
        .then(() => {
          done();
        })
        .catch(function (error) {
          done(error);
        });
    });

    it('should expire token in the token manager', (done) => {
      var
        tokenManagerExpired = false,
        user = new User();

      kuzzle.tokenManager.expire = function () {
        tokenManagerExpired = true;
      };
      user._id = 'userInCache';

      tokenRepository.generateToken(user, context)
        .then(function (token) {
          return tokenRepository.expire(token);
        })
        .then(() => {
          should(tokenManagerExpired).be.exactly(true);
          done();
        })
        .catch(function (error) {
          done(error);
        });
    });

    it('should return an internal error if an error append when expires a token', (done) => {
      var
        user = new User();

      Repository.prototype.expireFromCache = function () {
        return Promise.reject();
      };

      user._id = 'userInCache';

      tokenRepository.generateToken(user, context)
        .then(function (token) {
          return tokenRepository.expire(token);
        })
        .catch(function (error) {
          should(error).be.an.instanceOf(InternalError);
          should(error.message).be.exactly('Error expiring token');
          done();
        });
    });
  });

});

function assertIsAnonymous (token) {
  should(token._id).be.undefined();
  should(token.userId).be.exactly(-1);
}